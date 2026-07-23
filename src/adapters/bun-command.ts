import type { CommandAdapter, CommandExecutionResult, CommandRequest } from "./interfaces";

export class BunCommandAdapter implements CommandAdapter {
  public async execute(request: CommandRequest): Promise<CommandExecutionResult> {
    let processId: number | null = null;
    try {
      const subprocess = Bun.spawn([request.executable, ...request.argv], {
        cwd: request.cwd,
        env: { ...request.env },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      processId = subprocess.pid;
      subprocess.stdin.write(request.stdin);
      await subprocess.stdin.end();
      const [exitCode, stdout, stderr] = await Promise.all([
        subprocess.exited,
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
      ]);
      return {
        status: "exited",
        exitCode,
        stdout,
        stderr,
        processId,
      };
    } catch {
      return {
        status: "failed",
        classification: processId === null ? "spawn" : "transport",
        stdout: "",
        stderr: "",
        processId,
      };
    }
  }
}
