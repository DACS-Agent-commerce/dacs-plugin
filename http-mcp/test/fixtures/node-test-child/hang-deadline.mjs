// SIGKILL prevents a parent from cleaning up its detached child. Bound the
// hanging fixture's lifetime even when its parent's cleanup cannot run.
setTimeout(() => process.exit(1), 120_000).unref();
