import importlib.util
import math
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[1] / 'skills/blender-spatial/scripts/scores.py'
spec = importlib.util.spec_from_file_location('scores', path)
scores = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scores)


class SpatialRewards(unittest.TestCase):
    def setUp(self):
        self.layouts = {'object': {'min': [-.1, -.1, 1], 'max': [.1, .1, 1.4]},
                        'surface': {'min': [-1, -1, 0], 'max': [1, 1, 1]}}
        self.relation = {'type': 'support', 'axis': 'z', 'tolerance': .01,
                         'participants': [{'nodeId': 'object', 'role': 'subject'}, {'nodeId': 'surface', 'role': 'support'}]}

    def test_support_reward_distinguishes_good_near_and_bad_layouts(self):
        self.assertEqual(scores.score(self.layouts, self.relation), 1)
        self.layouts['object']['min'][2] = 1.005
        near = scores.score(self.layouts, self.relation)
        self.assertGreater(near, .5)
        self.layouts['object']['min'][2] = 1.1
        self.assertLess(scores.score(self.layouts, self.relation), near)
        self.assertLess(scores.score(self.layouts, self.relation), .5)

    def test_support_rejects_penetration_and_outside_footprint(self):
        self.layouts['object']['min'][2] = .9
        self.assertLess(scores.score(self.layouts, self.relation), .5)
        self.layouts['object'] = {'min': [3, 3, 1], 'max': [4, 4, 1.5]}
        self.assertLess(scores.score(self.layouts, self.relation), .5)

    def test_three_member_spacing_and_alignment_use_world_centers(self):
        row = {str(i): {'min': [i * 2 - .5, -.5, 0], 'max': [i * 2 + .5, .5, 1]} for i in range(3)}
        relation = {'type': 'spacing', 'axis': 'x', 'tolerance': .01, 'spacing': 2,
                    'participants': [{'nodeId': str(i), 'role': 'member'} for i in range(3)]}
        self.assertEqual(scores.score(row, relation), 1)
        row['1']['min'][0] += .4
        row['1']['max'][0] += .4
        self.assertLess(scores.score(row, relation), .5)
        relation.update(type='alignment', axis='y')
        self.assertEqual(scores.score(row, relation), 1)

    def test_exact_tolerance_and_large_error_have_bounded_rewards(self):
        self.relation['tolerance'] = 0
        self.assertEqual(scores.score(self.layouts, self.relation), 1)
        self.layouts['object']['min'][2] = 1.00001
        self.assertEqual(scores.score(self.layouts, self.relation), 0)
        self.relation['tolerance'] = 1e-200
        self.assertTrue(math.isfinite(scores.score(self.layouts, self.relation)))


if __name__ == '__main__':
    unittest.main()
