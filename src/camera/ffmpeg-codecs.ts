import { execFile } from 'node:child_process';
import os from 'node:os';
import util from 'node:util';
import ffmpegPath from 'ffmpeg-for-homebridge';
import { Logger } from 'homebridge';
import { ExecFileException } from 'child_process';

export class FfmpegCodecs {
  private readonly log: Logger;
  private _ffmpegCodecs?: {
    [codec: string]: { decoders: string[]; encoders: string[] };
  };

  constructor(log: Logger) {
    this.log = log;
    this._ffmpegCodecs = undefined;
  }

  public async getCodecs(codecsFilter: string[] | 'all'): Promise<{
    [codec: string]: { decoders: string[]; encoders: string[] };
  }> {
    if (this._ffmpegCodecs === undefined) {
      const stdout = await this.runCommand((ffmpegPath as unknown as string) || 'ffmpeg', [
        '-hide_banner',
        '-codecs',
      ]);
      const decodersRegex = /\S+\s+(?<codec>\S+).+\(decoders:(?<decoders>[^)]+)\)/;
      const encodersRegex = /\S+\s+(?<codec>\S+).+\(encoders:(?<encoders>[^)]+)\)/;
      this._ffmpegCodecs = {};

      for (const codecLine of stdout.toLowerCase().split(os.EOL)) {
        const encodersMatch = encodersRegex.exec(codecLine)?.groups;
        const decodersMatch = decodersRegex.exec(codecLine)?.groups;
        const codec = encodersMatch?.codec ?? decodersMatch?.codec;
        if (!codec) {
          continue;
        }
        this._ffmpegCodecs[codec] = {
          encoders: (encodersMatch?.encoders.trim().split(' ') ?? []).sort(),
          decoders: (decodersMatch?.decoders.trim().split(' ') ?? []).sort(),
        };
      }
    }
    return Object.fromEntries(
      Object.entries(this._ffmpegCodecs).filter(
        ([codec]) => codecsFilter === 'all' || codecsFilter.includes(codec),
      ),
    );
  }

  private async runCommand(command: string, commandLineArgs: string[]): Promise<string> {
    // Promisify exec to allow us to wait for it asynchronously.
    const execFileAsync = util.promisify(execFile);
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(command, commandLineArgs));
    } catch (e: unknown) {
      const execError = e as unknown as ExecFileException;
      const message =
        execError.code === 'ENOENT'
          ? `unable to find ${command} in PATH=${process.env.PATH}`
          : `error running ${command}: ${execError.message}`;
      this.log.error(message);
      this.log.error(
        "Unable to probe the capabilities of your Homebridge host without access to '%s'. Ensure that it is available in your path and permissions are set correctly.",
        command,
      );
      return '';
    }
    return stdout;
  }
}
