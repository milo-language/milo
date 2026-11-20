// The message templates of the borrow errors src/borrow-flow.ts reports; scripts/borrow-fuzz.ts judges generated programs by them.
// The flow class: the message templates src/borrow-flow.ts reports. scripts/borrow-fuzz.ts uses them to tell a borrow
// verdict from a local-rule error.
export const TEMPLATES: [string, RegExp][] = [
  ["call vs view", /^cannot call '.+' on '.+' while '[^']+' borrows .+$/],
  ["call vs loop", /^cannot call '.+' on '.+' while a loop iterates over .+$/],
  ["assign vs view", /^cannot assign to '.+' while '[^']+' borrows .+$/],
  ["assign vs loop", /^cannot assign to '.+' while a loop iterates over .+$/],
  ["elem assign vs loop", /^cannot assign to '.+' because '.+' is being iterated$/],
  ["pass/swap/replace vs view/loop", /^cannot (pass|swap|replace) '[^']+' while ('[^']+' borrows .+|a loop iterates over .+)$/],
  ["holder-less (it is borrowed)", /^cannot .+ because (it|'[^']+') is borrowed$/],
  ["park vs global view", /^.+ can park this task while '[^']+' (borrows from|still points into) .+'s buffer.*; another task may push to .+ before it resumes$/],
  ["global write vs global view", /^.+ writes the global '[^']+' while '[^']+' (borrows from|still points into) .+'s buffer.*$/],
  ["move vs view", /^cannot move '[^']+' while '[^']+' borrows .+$/],
  ["move vs loop", /^cannot move '[^']+' while a loop iterates over .+$/],
  ["call vs pointer", /^'.+' may reallocate here while '[^']+' still points into its buffer \(from '.+' on line \d+\)$/],
  ["assign vs pointer", /^'.+' is reassigned here while '[^']+' still points into its buffer \(from '.+' on line \d+\)$/],
  ["closure write vs view/loop", /^cannot write to .[^.]+. by (calling|passing) .[^.]+. while (.[^.]+. borrows .+|a loop iterates over .+)$/],
  ["closure write vs pointer", /^.+. is written by (calling|passing) .[^.]+. while .[^.]+. still points into its buffer \(from .+ on line \d+\)$/],
  ["elem write vs pointer", /^'.+' is written here while '[^']+' still points into its buffer \(from '.+' on line \d+\)$/],
];
export const templateOf = (m: string): string | null => TEMPLATES.find(([, re]) => re.test(m))?.[0] ?? null;
