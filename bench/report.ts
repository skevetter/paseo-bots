import type { BenchRegistration, BenchRunOptions } from "vitest";

/** Runs each benchmark in turn and prints its median and throughput. */
export async function report(
  title: string,
  registrations: readonly BenchRegistration<string>[],
  options?: BenchRunOptions,
): Promise<void> {
  const lines = [`\n${title}`];
  for (const registration of registrations) {
    const { latency, throughput } = await registration.run(options);
    lines.push(
      `  ${registration.name.padEnd(48)} median ${latency.p50.toFixed(4).padStart(9)} ms  ${Math.round(throughput.mean).toLocaleString("en-US").padStart(10)} ops/s`,
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}
