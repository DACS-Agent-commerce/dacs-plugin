#!/usr/bin/env python3
# Drives approval-tty-child.mjs on a real pseudo-terminal (there is no expect
# on every host). Usage, run with -I:
#   approval-tty-driver.py <node> <child.mjs> <evidence path> <late|control>
# late:    SIGUSR2 makes the child abort the shutdown signal while the prompt
#          waits; the exact APPROVE <hash> is typed only after that.
# control: the exact APPROVE <hash> is typed while the prompt waits.
# Prints the child's TTY- lines, the prompt count and the child's exit code.
# A child that has not closed the terminal DRAIN_SECONDS after its result (or
# after the result wait) is killed: the driver then prints the output it has,
# its own TTY-DRIVER-ERROR line, and exits 2, well within the caller's timeout.
import os, pty, re, select, signal, sys, time

DRAIN_SECONDS = 5

node, child, evidence, mode = sys.argv[1:5]
pid, fd = pty.fork()
if pid == 0:
    os.execv(node, [node, child, evidence, mode])

buf = b''
def pump(seconds):
    global buf
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return False
            if not chunk:
                return False
            buf += chunk
    return True

def wait_for(pattern, seconds):
    end = time.time() + seconds
    while not re.search(pattern, buf) and time.time() < end:
        if not pump(0.05):
            break
    return re.search(pattern, buf)

prompt = wait_for(rb'Type APPROVE ([0-9a-f]{64})', 15)
if prompt:
    if mode == 'late':
        os.kill(pid, signal.SIGUSR2)
        wait_for(rb'TTY-ABORTED', 5)
        # An approval that ignores the signal never settles here; the late answer is typed anyway.
        wait_for(rb'TTY-FIRST', 3)
    os.write(fd, b'APPROVE ' + prompt.group(1) + b'\r')
wait_for(rb'TTY-RESULT [^\r\n]*\r?\n', 20)
drain_end = time.time() + DRAIN_SECONDS
settled = False
while time.time() < drain_end:
    if not pump(0.2):
        settled = True
        break
try:
    _, status = os.waitpid(pid, os.WNOHANG)
    if _ == 0:
        os.kill(pid, signal.SIGKILL)
        _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status)
except ChildProcessError:
    code = None
out = buf.decode(errors='replace')
for line in out.splitlines():
    if line.startswith('TTY-'):
        print(line.strip())
print(f'TTY-PROMPTS {len(re.findall(r"Type APPROVE [0-9a-f]{64}", out))}')
print(f'TTY-EXIT {code}')
if not settled:
    print(f'TTY-DRIVER-ERROR the child did not close the terminal within {DRAIN_SECONDS} s of its result wait; it was killed')
    sys.exit(2)
