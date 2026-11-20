import { Vector3, Vector4 } from "three";
import { maxFogVolumes, maxSunShafts, type FogVolume, type SunShaft } from "../render-effects.js";

export function shaftUniforms(shafts: SunShaft[]) {
  const vectors = <T>(make: (shaft?: SunShaft) => T) => Array.from({ length: maxSunShafts }, (_, i) => make(shafts[i]));
  return {
    shaftCount: { value: Math.min(shafts.length, maxSunShafts) },
    shaftStart: { value: vectors(s => s ? new Vector4(...s.start, s.radii[0]) : new Vector4()) },
    shaftEnd: { value: vectors(s => s ? new Vector4(...s.end, s.radii[1]) : new Vector4()) },
    shaftMedium: { value: vectors(s => s ? new Vector4(...s.albedo, s.density) : new Vector4()) },
    shaftEmission: { value: vectors(s => s ? new Vector4(...s.emission, s.anisotropy) : new Vector4()) },
  };
}

export function fogUniforms(fog: FogVolume[]) {
  const vectors = <T>(make: (volume?: FogVolume) => T) => Array.from({ length: maxFogVolumes }, (_, i) => make(fog[i]));
  const ramps = (index: number) => vectors(volume => {
    const ramp = volume?.ramps[index];
    return ramp ? new Vector4(...ramp.range, ...ramp.density) : new Vector4(0, 1, 1, 1);
  });
  return {
    fogCount: { value: Math.min(fog.length, maxFogVolumes) },
    fogMin: { value: vectors(v => v ? new Vector4(...v.min, v.ramps[0]?.axis ?? 0) : new Vector4()) },
    fogMax: { value: vectors(v => v ? new Vector4(...v.max, v.ramps[1]?.axis ?? 0) : new Vector4()) },
    fogMedium: { value: vectors(v => v ? new Vector4(...v.albedo, v.density) : new Vector4()) },
    fogEmission: { value: vectors(v => v ? new Vector4(...v.emission, v.anisotropy) : new Vector4()) },
    fogRampA: { value: ramps(0) }, fogRampB: { value: ramps(1) },
  };
}

export const solarVolumeShader = `
  uniform vec4 shaftStart[${maxSunShafts}], shaftEnd[${maxSunShafts}];
  uniform vec4 shaftMedium[${maxSunShafts}], shaftEmission[${maxSunShafts}];
  uniform int shaftCount;
  uniform int fogCount;
  uniform vec4 fogMin[${maxFogVolumes}], fogMax[${maxFogVolumes}], fogMedium[${maxFogVolumes}], fogEmission[${maxFogVolumes}];
  uniform vec4 fogRampA[${maxFogVolumes}], fogRampB[${maxFogVolumes}];
  float rampDensity(vec4 ramp, float coordinate) {
    return mix(ramp.z,ramp.w,clamp((coordinate-ramp.x)/(ramp.y-ramp.x),0.0,1.0));
  }
  vec4 integrateFog(vec3 origin, vec3 direction, float surfaceDistance) {
    vec3 radiance = vec3(0.0);
    float extinction = 0.0;
    vec3 invRay = (step(vec3(0),direction)*2.0-1.0)/max(abs(direction),vec3(1e-6));
    for (int i = 0; i < ${maxFogVolumes}; i++) {
      if (i >= fogCount) break;
      vec3 a = (fogMin[i].xyz-origin)*invRay, b = (fogMax[i].xyz-origin)*invRay;
      vec3 lower = min(a,b), upper = max(a,b);
      float lo = max(0.0,max(max(lower.x,lower.y),lower.z)), hi = min(surfaceDistance,min(min(upper.x,upper.y),upper.z));
      if (hi <= lo) continue;
      float stepLength = (hi-lo)/16.0, g = clamp(fogEmission[i].w,-0.95,0.95);
      float phase = (1.0-g*g)/pow(1.0+g*g-2.0*g*dot(direction,sunDirection),1.5);
      for (int j = 0; j < 16; j++) {
        vec3 p = origin + direction*(lo+(float(j)+0.5)*stepLength);
        float tau = fogMedium[i].w * rampDensity(fogRampA[i],p[int(fogMin[i].w)]) * rampDensity(fogRampB[i],p[int(fogMax[i].w)]) * stepLength;
        vec3 lighting = vec3(0.045,0.055,0.075)+sunColor*sunlight(p)*phase;
        radiance += exp(-extinction) * (fogEmission[i].rgb * stepLength + (1.0-exp(-tau))*fogMedium[i].rgb*lighting);
        extinction += tau;
      }
    }
    return vec4(radiance, exp(-extinction));
  }
  vec4 integrateShafts(vec3 origin, vec3 direction, float surfaceDistance) {
    vec3 radiance = vec3(0.0);
    float extinction = 0.0;
    for (int i = 0; i < ${maxSunShafts}; i++) {
      if (i >= shaftCount) break;
      vec4 start = shaftStart[i], end = shaftEnd[i];
      vec3 segment = end.xyz - start.xyz, offset = origin - start.xyz;
      float lengthAlong = length(segment);
      vec3 axis = segment / lengthAlong;
      float axialOrigin = dot(offset, axis), axialRay = dot(direction, axis);
      vec3 radialOrigin = offset - axis * axialOrigin, radialRay = direction - axis * axialRay;
      float a = dot(radialRay, radialRay), b = dot(radialOrigin, radialRay);
      float maxRadius = max(start.w, end.w);
      float c = dot(radialOrigin, radialOrigin) - maxRadius * maxRadius;
      float lo = 0.0, hi = surfaceDistance;
      if (a > 1e-8) {
        float discriminant = b*b - a*c;
        if (discriminant <= 0.0) continue;
        lo = max(lo, (-b-sqrt(discriminant))/a);
        hi = min(hi, (-b+sqrt(discriminant))/a);
      } else if (c > 0.0) continue;
      if (abs(axialRay) > 1e-8) {
        float t0 = (-0.018*lengthAlong-axialOrigin)/axialRay, t1 = (1.025*lengthAlong-axialOrigin)/axialRay;
        lo = max(lo, min(t0,t1)); hi = min(hi, max(t0,t1));
      } else if (axialOrigin < -0.018*lengthAlong || axialOrigin > 1.025*lengthAlong) continue;
      if (hi <= lo) continue;
      float stepLength = (hi-lo)/24.0, g = clamp(shaftEmission[i].w,-0.95,0.95);
      float phase = (1.0-g*g)/pow(1.0+g*g-2.0*g*dot(direction,sunDirection),1.5);
      for (int j = 0; j < 24; j++) {
        float t = lo + (float(j)+0.5)*stepLength;
        float along = (axialOrigin+t*axialRay)/lengthAlong;
        float radius = mix(start.w,end.w,clamp(along,0.0,1.0));
        float radial = length(radialOrigin+t*radialRay)/radius;
        float weight = (1.0-smoothstep(0.13,1.0,radial))*smoothstep(-0.018,0.13,along)*
          (1.0-smoothstep(0.68,1.025,along))*stepLength;
        float tau = shaftMedium[i].w * weight;
        radiance += exp(-extinction) * (shaftEmission[i].rgb * weight +
          (1.0-exp(-tau))*shaftMedium[i].rgb*sunColor*phase);
        extinction += tau;
      }
    }
    return vec4(radiance, exp(-extinction));
  }
`;
