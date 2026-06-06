#!/usr/bin/env python3
"""
Daemonized restart — survives gateway death via double-fork + setsid.

Usage:
    python3 scripts/daemon-restart.py [--no-build]

This re-execs prod-restart.sh with the same flags, but fully orphaned
from the calling process tree (re-parented to PID 1 / launchd).
Log output: /tmp/prod-restart.log
"""
import os, sys

LOG = '/tmp/prod-restart.log'
SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'prod-restart.sh')

# First fork — child continues, parent returns immediately
pid = os.fork()
if pid > 0:
    sys.exit(0)

# New session group — no longer attached to parent's terminal/session
os.setsid()

# Second fork — guarantee re-parenting to launchd (PID 1)
pid = os.fork()
if pid > 0:
    sys.exit(0)

# Redirect stdio to log file
log_fd = os.open(LOG, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
os.dup2(log_fd, 1)
os.dup2(log_fd, 2)
os.close(log_fd)
os.close(0)

# Build args: prod-restart.sh <passed flags> --daemonized
# --daemonized tells prod-restart.sh it's already daemonized (skip re-fork)
args = ['/bin/bash', SCRIPT] + sys.argv[1:] + ['--daemonized']
os.execv('/bin/bash', args)
