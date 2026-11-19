import * as THREE from "three";
import type { Volume } from "../shared/vfx.js";

export const maxVolumes = 8;
const maxLocalLights = 8;

export function volumeUniforms(volumes: Volume[], scene: THREE.Scene, camera: THREE.Camera) {
  scene.updateMatrixWorld(true);
  const lights: (THREE.PointLight | THREE.SpotLight | THREE.RectAreaLight)[] = [];
  if (volumes.length) scene.traverse(object => {
    if (object instanceof THREE.PointLight || object instanceof THREE.SpotLight || object instanceof THREE.RectAreaLight) lights.push(object);
  });
  const cameraPosition = new THREE.Vector3(), position = new THREE.Vector3();
  const ranked = lights.map(light => ({ light, score: 0 }));
  const vectors = (length: number, make: (i: number) => THREE.Vector4) => Array.from({ length }, (_, i) => make(i));
  const uniforms = {
    volumeCount: { value: Math.min(volumes.length, maxVolumes) },
    volumeMin: { value: vectors(maxVolumes, i => new THREE.Vector4(...(volumes[i]?.min ?? [-1e7, -1e7, -1e7]), volumes[i]?.density ?? 0)) },
    volumeMax: { value: vectors(maxVolumes, i => new THREE.Vector4(...(volumes[i]?.max ?? [1e7, 1e7, 1e7]), volumes[i]?.anisotropy ?? 0)) },
    volumeColor: { value: vectors(maxVolumes, i => new THREE.Vector4(...(volumes[i]?.color ?? [0, 0, 0]), volumes[i]?.noiseScale ?? 0)) },
    volumeEmission: { value: vectors(maxVolumes, i => new THREE.Vector4(...(volumes[i]?.emission ?? [0, 0, 0]), 0)) },
    volumeHeight: { value: vectors(maxVolumes, i => {
      const h = volumes[i]?.height;
      return h ? new THREE.Vector4(h.start, h.depth, h.top ?? 0, h.mode === "linear" ? 1 : 2) : new THREE.Vector4();
    }) },
    localCount: { value: 0 },
    localPosition: { value: vectors(maxLocalLights, () => new THREE.Vector4()) },
    localDirection: { value: vectors(maxLocalLights, () => new THREE.Vector4()) },
    localColor: { value: vectors(maxLocalLights, () => new THREE.Vector4()) },
    localShadow: { value: null as THREE.Texture | null },
    localShadowMatrix: { value: new THREE.Matrix4() },
    shadowedLocal: { value: -1 },
  };
  const forward = new THREE.Vector3(), target = new THREE.Vector3();
  return {
    uniforms,
    update() {
      if (!ranked.length) return;
      camera.getWorldPosition(cameraPosition);
      for (const entry of ranked) {
        entry.score = Math.max(0.01, entry.light.intensity) /
          Math.max(1, entry.light.getWorldPosition(position).distanceToSquared(cameraPosition));
      }
      ranked.sort((a, b) => b.score - a.score);
      const count = Math.min(ranked.length, maxLocalLights);
      uniforms.localCount.value = count;
      uniforms.shadowedLocal.value = -1;
      for (let i = 0; i < count; i++) {
        const light = ranked[i]!.light;
        light.getWorldPosition(position);
        const area = light instanceof THREE.RectAreaLight;
        const cone = light instanceof THREE.SpotLight;
        if (cone) forward.copy(light.target.getWorldPosition(target)).sub(position).normalize();
        else light.getWorldDirection(forward).negate();
        uniforms.localPosition.value[i]!.set(position.x, position.y, position.z, area ? Math.max(0.25, light.width * light.height / Math.PI) : 0.25);
        uniforms.localDirection.value[i]!.set(forward.x, forward.y, forward.z, cone ? Math.cos(light.angle) : area ? 0 : -2);
        const intensity = area ? light.intensity * light.width * light.height : light.intensity;
        uniforms.localColor.value[i]!.set(light.color.r * intensity, light.color.g * intensity, light.color.b * intensity,
          cone ? Math.cos(light.angle * (1 - light.penumbra)) : area ? -1 : -2);
        if (uniforms.shadowedLocal.value < 0 && cone && light.castShadow && light.shadow.map) {
          uniforms.localShadow.value = light.shadow.map.texture;
          uniforms.localShadowMatrix.value.copy(light.shadow.matrix);
          uniforms.shadowedLocal.value = i;
        }
      }
    },
  };
}

export const volumeShader = `
  uniform vec4 volumeMin[${maxVolumes}],volumeMax[${maxVolumes}],volumeColor[${maxVolumes}],volumeHeight[${maxVolumes}],volumeEmission[${maxVolumes}];
  uniform vec4 localPosition[${maxLocalLights}],localDirection[${maxLocalLights}],localColor[${maxLocalLights}];
  uniform int volumeCount,localCount,shadowedLocal;
  uniform sampler2D localShadow;
  uniform mat4 localShadowMatrix;

  float phaseHG(float g,float mu) {
    return (1.0-g*g)/pow(max(0.0001,1.0+g*g-2.0*g*mu),1.5);
  }

  float localVisibility(vec3 world) {
    vec4 projected=localShadowMatrix*vec4(world,1.0);
    if(projected.w<=0.0)return 1.0;
    vec3 q=projected.xyz/projected.w;
    if(any(lessThan(q,vec3(0)))||any(greaterThan(q,vec3(1))))return 1.0;
    return step(q.z-0.001,unpackRGBAToDepth(texture2D(localShadow,q.xy)));
  }

  vec3 volumeLight(vec3 world,vec3 direction,float g) {
    vec3 light=vec3(0.045,0.055,0.075)+sunColor*sunlight(world)*phaseHG(g,dot(direction,sunDirection));
    for(int i=0;i<${maxLocalLights};i++) {
      if(i>=localCount)break;
      vec3 toward=localPosition[i].xyz-world;
      float d2=max(dot(toward,toward),0.0001);
      toward*=inversesqrt(d2);
      float cone=dot(-toward,localDirection[i].xyz);
      float edge=localDirection[i].w,inner=localColor[i].w;
      float shape=inner==-2.0?1.0:inner==-1.0?max(0.0,cone):smoothstep(edge,max(edge+0.0001,inner),cone);
      float visible=i==shadowedLocal?localVisibility(world):1.0;
      light+=localColor[i].rgb*(shape*visible*phaseHG(g,dot(direction,toward))/(12.56637*(d2+localPosition[i].w)));
    }
    return light;
  }

  vec3 applyVolumes(vec3 source,vec3 origin,vec3 direction,float surfaceDistance) {
    if(volumeCount==0)return source;
    float entries[${maxVolumes}],exits[${maxVolumes}];
    vec3 inverseRay=1.0/(sign(direction+vec3(1e-12))*max(abs(direction),vec3(1e-6)));
    float transmittance=1.0;
    vec3 scatter=vec3(0);
    float t=surfaceDistance;
    for(int i=0;i<${maxVolumes};i++) {
      entries[i]=surfaceDistance;exits[i]=-1.0;
      if(i>=volumeCount)continue;
      vec3 nearHit=(volumeMin[i].xyz-origin)*inverseRay,farHit=(volumeMax[i].xyz-origin)*inverseRay;
      vec3 lo=min(nearHit,farHit),hi=max(nearHit,farHit);
      float start=max(0.0,max(max(lo.x,lo.y),lo.z));
      float end=min(surfaceDistance,min(min(hi.x,hi.y),hi.z));
      if(end<=start)continue;
      entries[i]=start;exits[i]=end;t=min(t,start);
    }
    float jitter=hash(vec3(vUv*900.0,0.31));
    for(int segment=0;segment<${2 * maxVolumes};segment++) {
      if(t>=surfaceDistance||transmittance<0.002)break;
      float end=surfaceDistance;
      bool inMedium=false;
      for(int i=0;i<${maxVolumes};i++) {
        if(i>=volumeCount)break;
        if(entries[i]>t)end=min(end,entries[i]);
        if(exits[i]>t)end=min(end,exits[i]);
        inMedium=inMedium||(t>=entries[i]&&t<exits[i]);
      }
      if(inMedium) {
        // Subdivide at volume boundaries so shallow layers survive long camera rays.
        float stepSize=(end-t)/16.0;
        for(int step=0;step<16;step++) {
          vec3 world=origin+direction*(t+(float(step)+jitter)*stepSize);
          float extinction=0.0;
          vec3 radiance=vec3(0);
          for(int i=0;i<${maxVolumes};i++) {
            if(i>=volumeCount)break;
            if(t<entries[i]||t>=exits[i])continue;
            vec4 height=volumeHeight[i];
            float density=volumeMin[i].w;
            float y=(world.y-height.x)/max(height.y,0.0001);
            if(height.w==1.0)density=mix(density,height.z,clamp(y,0.0,1.0));
            if(height.w==2.0)density*=exp(-max(y,0.0));
            if(volumeColor[i].w>0.0)density*=noise(world*volumeColor[i].w);
            float tau=stepSize*density;
            if(tau>1e-7)radiance+=tau*volumeColor[i].rgb*volumeLight(world,direction,volumeMax[i].w);
            radiance+=volumeEmission[i].rgb*stepSize;
            extinction+=tau;
          }
          float opacity=1.0-exp(-extinction);
          scatter+=transmittance*radiance*(extinction>1e-5?opacity/extinction:1.0);
          transmittance*=1.0-opacity;
        }
      }
      t=end;
    }
    return source*transmittance+scatter;
  }
`;
