"""Pure spatial rewards. Inputs are world-space node layouts, never scene names.

All rewards are finite numbers in [0, 1]. For built-ins, 0.5 is the frozen
tolerance boundary. Independent measurements and render review still apply.
"""
import math


def error(layouts, relation):
    members = relation['participants']
    boxes = [layouts[p['nodeId']] for p in members]
    axis = {'x': 0, 'y': 1, 'z': 2}[relation['axis']]
    centers = sorted((b['min'][axis] + b['max'][axis]) / 2 for b in boxes)
    if relation['type'] == 'support':
        subject = boxes[next(i for i, p in enumerate(members) if p['role'] == 'subject')]
        surface = boxes[next(i for i, p in enumerate(members) if p['role'] == 'support')]
        outside = []
        for i in (0, 1):
            center = (subject['min'][i] + subject['max'][i]) / 2
            outside.append(max(surface['min'][i] - center, center - surface['max'][i], 0))
        return max(abs(subject['min'][2] - surface['max'][2]), *outside)
    if relation['type'] == 'alignment':
        return centers[-1] - centers[0]
    if relation['type'] == 'spacing':
        return max(abs(b - a - relation['spacing']) for a, b in zip(centers, centers[1:]))
    raise ValueError('No built-in scorer for ' + relation['type'])


def score(layouts, relation):
    distance = error(layouts, relation)
    tolerance = relation['tolerance']
    if tolerance == 0:
        return 1.0 if distance == 0 else 0.0
    # A bounded smooth reward supplies search direction outside the tolerance.
    ratio = distance / tolerance
    return 1.0 / (1.0 + ratio * ratio) if math.isfinite(ratio) else 0.0
