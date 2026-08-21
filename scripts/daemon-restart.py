#!/usr/bin/env python3
"""
Daemonized restart — survives gateway death via double-fork + setsid.

Usage:
    python3 scripts/daemon-restart.py [--no-build]

This re-execs prod-restart.sh with the same flags, but fully orphaned
from the calling process tree (re-parented to PID 1 / launchd) and with
the gateway service's identity env scrubbed so the restart reads as
external to the launchd install/stop guards.
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

# Scrub the gateway service's identity env before exec. fork() inherits it,
# and the external-shell guards in src/daemon/launchd-current-service.ts key
# on exactly these variables, not on process-tree membership: launchd's own
# label vars (set on the service and every descendant) plus the managed-wrapper
# markers. Leaving them in makes `gateway install` refuse to reinstall the
# LaunchAgent this restart just removed, stranding the gateway with no service
# (2026-08-21 outage; evidence /tmp/prod-restart-2026-08-21-outage.log).
# OPENCLAW_GATEWAY_SERVICE_PID names the gateway process the restart is about
# to kill; keep it and every guard/consumer sees a stale "inside" signal.
# OPENCLAW_LAUNCHD_LABEL is kept on purpose: it selects which label to
# reinstall, and the install/stop guards ignore it (allowConfiguredLabelFallback
# is false there), so it cannot fake service membership on its own.
child_env = dict(os.environ)
for var in (
    'XPC_SERVICE_NAME',
    'LAUNCH_JOB_LABEL',
    'LAUNCH_JOB_NAME',
    'OPENCLAW_SERVICE_MARKER',
    'OPENCLAW_SERVICE_KIND',
    'OPENCLAW_GATEWAY_SERVICE_PID',
):
    child_env.pop(var, None)

# Build args: prod-restart.sh <passed flags> --daemonized
# --daemonized tells prod-restart.sh it's already daemonized (skip re-fork)
args = ['/bin/bash', SCRIPT] + sys.argv[1:] + ['--daemonized']
os.execve('/bin/bash', args, child_env)
