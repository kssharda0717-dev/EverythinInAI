#!/usr/bin/env python3
"""
One-shot patch: makes DiscoveryStateMachine.transition() idempotent,
so resuming a run where state == newState becomes a no-op instead of
throwing 'Invalid transition: X -> X'.
"""
import sys

p = 'engine/core/state-machine.js'
s = open(p).read()

old = """  async transition(newState) {
    const allowed = TRANSITIONS[this.state];
    if (!allowed || !allowed.includes(newState)) {
      throw new Error(`Invalid transition: ${this.state} \u2192 ${newState}. Allowed: [${allowed?.join(', ')}]`);
    }"""

new = """  async transition(newState) {
    // Idempotent: re-transitioning to the same state during resume is a no-op.
    if (this.state === newState) {
      return;
    }
    const allowed = TRANSITIONS[this.state];
    if (!allowed || !allowed.includes(newState)) {
      throw new Error(`Invalid transition: ${this.state} \u2192 ${newState}. Allowed: [${allowed?.join(', ')}]`);
    }"""

if old in s:
    open(p, 'w').write(s.replace(old, new))
    print('PATCHED OK')
else:
    print('SOURCE BLOCK NOT FOUND')
    print('Showing first 80 chars of transition() in the file for debugging:')
    idx = s.find('async transition(newState)')
    if idx != -1:
        print(s[idx:idx+400])
    sys.exit(1)
