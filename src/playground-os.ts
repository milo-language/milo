// `os` for the playground bundle: target.ts imports these for getHostTarget, which the
// playground never calls (it passes an explicit linux-x64 target).
export const arch = (): string => "x64";
export const platform = (): string => "linux";
