"""Run host-authored library fixtures in disposable scenes on SceneStore's queue.

This uses the same trusted-code boundary as scene_edit, not an OS sandbox.
SceneStore restores the task scene after execution, including failures.
"""
import bpy
import io
import json
import types
import unittest

_request = json.loads(__SKILL_REQUEST__)
_results = []
for _fixture in _request['fixtures']:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    _skill = types.ModuleType('learned_skill')
    _tests = types.ModuleType('skill_tests')
    _tests.skill = _skill
    try:
        exec(compile(_request['code'], '<learned-skill>', 'exec'), _skill.__dict__)
        exec(compile(_fixture['code'], '<skill-fixture>', 'exec'), _tests.__dict__)
        _suite = unittest.defaultTestLoader.loadTestsFromModule(_tests)
        _report = unittest.TextTestRunner(stream=io.StringIO()).run(_suite)
        _passed = (_report.testsRun > 0 and _report.wasSuccessful() and not _report.skipped
                   and not _report.expectedFailures and not _report.unexpectedSuccesses)
        _errors = [trace[-3000:] for _, trace in _report.errors + _report.failures]
        if not _passed and not _errors:
            _errors = ['Fixtures require executed passing tests; empty, skipped and expected-failure suites do not qualify.']
        _results.append({'name': _fixture['name'], 'testsRun': _report.testsRun,
                         'passed': bool(_passed), 'errors': _errors[:5]})
    except Exception as _error:
        _results.append({'name': _fixture['name'], 'testsRun': 0, 'passed': False,
                         'errors': [type(_error).__name__ + ': ' + str(_error)[:3000]]})
result = {'fixtures': _results, 'blenderVersion': bpy.app.version_string}
