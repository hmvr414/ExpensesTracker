import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function runTesseract(filePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('tesseract', [filePath, 'stdout', '-l', 'eng']);
    return stdout.trim();
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw Object.assign(new Error('tesseract is not installed or not in PATH'), {
        code: 'TESSERACT_NOT_FOUND',
      });
    }
    throw err;
  }
}
