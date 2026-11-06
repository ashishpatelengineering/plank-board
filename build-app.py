#!/usr/bin/env python3
"""Builds public/index.html: the app plus the team code. Usage: build-app.py [path-to-app-index.html]"""
import re, sys, pathlib
here = pathlib.Path(__file__).parent
src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else here / 'app/index.html').read_text(encoding='utf-8')
ops = (here / 'shared/ops.js').read_text(encoding='utf-8')
ops = re.sub(r'^export (class|function|const|let) ', r'\1 ', ops, flags=re.M)
assert 'export ' not in ops.replace('// export', ''), 'unstripped export'
team = (here / 'client/team.js').read_text(encoding='utf-8')
assert '/*TEAM-CODE*/' in src, 'app has no team hook'
# the shared module and the team code share one scope so they can use each other's names
block = '(() => {\n' + ops + '\n' + team.replace('(() => {\nT.on = true;', 'T.on = true;', 1).rsplit('})();', 1)[0] + '\n})();'
out = src.replace('/*TEAM-CODE*/', block, 1)
(here / 'public').mkdir(exist_ok=True)
(here / 'public/index.html').write_text(out, encoding='utf-8')
print('built public/index.html', len(out), 'bytes')
