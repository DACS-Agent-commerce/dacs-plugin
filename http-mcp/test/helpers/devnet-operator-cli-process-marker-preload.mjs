process.stdout.write(`${JSON.stringify({kind:'dacs-test-application-process',pid:process.pid,entrypoint:process.argv[1]??null})}\n`);
