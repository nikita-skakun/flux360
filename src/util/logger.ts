let verbose = false;

export function setVerbose(enabled: boolean) {
  verbose = enabled;
}

export function vlog(...args: unknown[]) {
  if (verbose) {
    console.log(...args);
  }
}
