import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'send-key.ps1');
const CODE_RE = /^(Alt|Control|Shift)(Left|Right)$|^(Enter|Space|Escape|Tab|Backspace|Delete|Home|End|PageUp|PageDown|Arrow(Up|Down|Left|Right))$|^Key[A-Z]$|^Digit[0-9]$|^F(?:[1-9]|1[0-9]|2[0-4])$/;

function sendKey(code) {
    return new Promise((resolve, reject) => {
        const child = spawn('powershell.exe', [
            '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', scriptPath, '-Code', code,
        ], { windowsHide: true });
        let error = '';
        child.stderr.on('data', (chunk) => { error += chunk; });
        child.once('error', reject);
        child.once('exit', (exitCode) => exitCode === 0 ? resolve() : reject(new Error(error.trim() || `SendInput failed (${exitCode})`)));
    });
}

export async function init(router) {
    router.get('/status', (_req, res) => res.json({ ok: process.platform === 'win32' }));
    router.post('/press', async (req, res) => {
        const code = String(req.body?.code || '');
        if (process.platform !== 'win32') return res.status(501).json({ ok: false, error: 'Windows only' });
        if (!CODE_RE.test(code)) return res.status(400).json({ ok: false, error: `Unsupported key: ${code}` });
        try {
            await sendKey(code);
            return res.json({ ok: true, code });
        } catch (error) {
            console.error('[st-overlay-sandbox-key]', error);
            return res.status(500).json({ ok: false, error: error.message });
        }
    });
}

export const info = {
    id: 'st-overlay-sandbox-key',
    name: 'Overlay Sandbox Native Key Bridge',
    description: 'Sends allow-listed Windows keys for the Overlay Sandbox mobile button.',
};
