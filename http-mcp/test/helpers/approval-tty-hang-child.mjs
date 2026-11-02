// A child that never settles, for approval-tty-driver.py's own deadline: it
// shows the exact prompt shape and a result line, then ignores SIGUSR2 (the
// stop) and keeps its event loop alive without closing the terminal.
process.on('SIGUSR2', () => {});
process.stdout.write(`Type APPROVE ${'c'.repeat(64)} to authorize this exact seller transaction: \n`);
process.stdout.write('TTY-RESULT {"hang":true}\n');
setInterval(() => {}, 1000);
