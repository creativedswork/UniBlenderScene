"""Bounded layout search on SceneStore's dedicated bridge.

Learned code has the same trusted host-code boundary as scene_edit. Scorers
must only read their layout/relationship arguments; they must not mutate bpy.
"""
import copy
import math
import types
import bpy
from mathutils import Matrix, Vector


class SpatialLayout:
    def __init__(self, request):
        self.request = request
        self.graph = {n['id']: n for n in request['graph']}
        self.names = {name: n['id'] for n in self.graph.values() for name in n['blenderObjectNames']}
        self.modules = {}
        for entry in [request['builtin'], *request['skills']]:
            module = types.ModuleType('spatial_score')
            exec(compile(entry['code'], '<spatial-score:' + entry['id'] + '>', 'exec'), module.__dict__)
            if not callable(getattr(module, 'score', None)):
                raise ValueError('Spatial scorer must define score(layouts, relation)')
            self.modules[entry['id']] = module
        self.bindings = {b['relationId']: b for b in request['bindings']}

    def owner(self, obj):
        while obj:
            node_id = obj.get('scene_node_id') or self.names.get(obj.name)
            if node_id:
                return node_id, obj
            obj = obj.parent
        return None, None

    def geometry(self):
        bpy.context.view_layer.update()
        depsgraph = bpy.context.evaluated_depsgraph_get()
        bounds, owners = {}, {}
        for obj in bpy.context.scene.objects:
            if obj.type != 'MESH' or obj.hide_render:
                continue
            node_id, owner = self.owner(obj)
            if node_id not in self.graph:
                continue
            evaluated = obj.evaluated_get(depsgraph)
            if not len(evaluated.data.vertices):
                continue
            corners = [evaluated.matrix_world @ Vector(c) for c in evaluated.bound_box]
            low = [min(c[i] for c in corners) for i in range(3)]
            high = [max(c[i] for c in corners) for i in range(3)]
            if not all(math.isfinite(v) for v in low + high):
                continue
            owners.setdefault(node_id, {})[owner.name] = [list(row) for row in owner.matrix_world]
            while node_id in self.graph:
                box = bounds.setdefault(node_id, {'min': low[:], 'max': high[:]})
                box['min'] = [min(a, b) for a, b in zip(box['min'], low)]
                box['max'] = [max(a, b) for a, b in zip(box['max'], high)]
                node_id = self.graph[node_id]['parentId']
        frames = {key: next(iter(values.values())) for key, values in owners.items() if len(values) == 1}
        layouts = {key: {**box, **({'matrixWorld': frames[key]} if key in frames else {})}
                   for key, box in bounds.items()}
        return bounds, frames, layouts

    def evaluate(self, layouts, relation_ids=None, bindings=None):
        bindings = self.bindings if bindings is None else bindings
        results = []
        for relation in self.request['relations']:
            if relation_ids is not None and relation['id'] not in relation_ids:
                continue
            if relation['type'] == 'semantic':
                results.append({'relationId': relation['id'], 'status': 'visual', 'score': None})
                continue
            binding = bindings.get(relation['id'], self.request['builtin'])
            entry = {'relationId': relation['id'], 'scorerId': binding['id'], 'scorerHash': binding['hash']}
            try:
                if any(p['nodeId'] not in layouts for p in relation['participants']):
                    raise ValueError('Missing mapped mesh bounds')
                value = self.modules[binding['id']].score(copy.deepcopy(layouts), copy.deepcopy(relation))
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1:
                    raise ValueError('score(layouts, relation) must return a finite number in [0, 1]')
                threshold = relation.get('minScore', 0.5)
                results.append({**entry, 'score': value, 'status': 'passed' if value >= threshold else 'failed'})
            except Exception as error:
                results.append({**entry, 'score': None, 'status': 'unmeasurable', 'evidence': str(error)[:1000]})
        values = [r['score'] for r in results if r['status'] != 'visual']
        total = sum(values) / len(values) if values and all(v is not None for v in values) else None
        return {'score': total, 'results': results}

    def snapshot(self):
        bounds, frames, layouts = self.geometry()
        return {'relationBounds': bounds, 'relationFrames': frames, 'spatialEvaluation': self.evaluate(layouts)}

    def optimize(self, options):
        relation_ids = set(options['relationIds'])
        movable = set(options['movableNodeIds'])
        objects = [o for o in bpy.context.scene.objects if self.owner(o)[0] in movable]
        roots = []
        for obj in objects:
            parent = obj.parent
            while parent and parent not in objects:
                parent = parent.parent
            if parent is None:
                roots.append(obj)
        if not roots or any(not any(self.owner(o)[0] == node_id for o in roots) for node_id in movable):
            raise ValueError('Each movable node needs an independent mapped object root; remove overlapping parent/child scopes')
        if any(o.type in {'CAMERA', 'LIGHT'} for o in objects):
            raise ValueError('Layout optimization cannot move cameras or lights')
        trial_bindings = dict(self.bindings)
        trial_bindings.update({b['relationId']: b for b in options.get('overrides', [])})
        def measure():
            layouts = self.geometry()[2]
            builtin_ids = {r['id'] for r in self.request['relations'] if r['type'] not in {'skill', 'semantic'}} & relation_ids
            return (self.evaluate(layouts, relation_ids, trial_bindings), self.evaluate(layouts, relation_ids),
                    self.evaluate(layouts, builtin_ids, bindings={}))
        current, baseline, independent = measure()
        if current['score'] is None or baseline['score'] is None:
            raise ValueError('Optimization needs measurable active relations and finite scores')
        initial, initial_baseline, initial_independent = copy.deepcopy(current), copy.deepcopy(baseline), copy.deepcopy(independent)
        evaluations, accepted = 1, 0
        steps = [options['translationStep'] / (2 ** level) for level in range(options['passes'])]
        for level, step in enumerate(steps):
            for node_id in options['movableNodeIds']:
                bpy.context.view_layer.update()
                group = [o for o in roots if self.owner(o)[0] == node_id]
                original = {o: o.matrix_world.copy() for o in group}
                box = self.geometry()[0][node_id]
                low, high = box['min'], box['max']
                pivot = Vector([(a + b) / 2 for a, b in zip(low, high)])
                changes = [Matrix.Translation(Vector([step * sign if i == axis else 0 for i in range(3)]))
                           for axis in range(3) for sign in (-1, 1)]
                angle = options['rotationStepDegrees'] / (2 ** level)
                if angle:
                    changes.extend(Matrix.Translation(pivot) @ Matrix.Rotation(math.radians(angle * sign), 4, 'Z') @ Matrix.Translation(-pivot)
                                   for sign in (-1, 1))
                best_change, best_trial, best_baseline, best_independent = None, current, baseline, independent
                for change in changes:
                    for obj, matrix in original.items():
                        obj.matrix_world = change @ matrix
                    trial, frozen, fixed = measure()
                    evaluations += 1
                    # Do not break an already passing frozen relation to game a
                    # new candidate's objective. Render review remains separate.
                    frozen_by_id = {r['relationId']: r for r in frozen['results']}
                    preserved = all(r['status'] != 'passed' or frozen_by_id[r['relationId']]['status'] == 'passed'
                                    for r in baseline['results'])
                    fixed_by_id = {r['relationId']: r for r in fixed['results']}
                    preserved = preserved and all(r['status'] != 'passed' or fixed_by_id[r['relationId']]['status'] == 'passed'
                                                  for r in independent['results'])
                    if trial['score'] is not None and frozen['score'] is not None and preserved and \
                       trial['score'] > best_trial['score'] + 1e-12 and frozen['score'] >= baseline['score'] - 1e-12:
                        best_change, best_trial, best_baseline, best_independent = change, trial, frozen, fixed
                for obj, matrix in original.items():
                    obj.matrix_world = best_change @ matrix if best_change is not None else matrix
                if best_change is not None:
                    current, baseline, independent = best_trial, best_baseline, best_independent
                    accepted += 1
        bpy.context.view_layer.update()
        return {'before': initial, 'after': current, 'frozenBefore': initial_baseline, 'frozenAfter': baseline,
                'independentBefore': initial_independent, 'independentAfter': independent,
                'evaluations': evaluations, 'acceptedMoves': accepted, 'movableNodeIds': options['movableNodeIds'],
                'candidateOverrides': options.get('overrides', []), 'visualVerificationRequired': True}
