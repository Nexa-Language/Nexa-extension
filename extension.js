/**
 * Nexa Language Extension for VSCode
 *
 * Provides:
 *   - Syntax highlighting (via TextMate grammar)
 *   - Build command (nexa build)
 *   - Run command (nexa run / nexa build + python)
 *   - Harness Check (nexa harness-check)
 *   - Validate (nexa validate)
 *
 * Commands are available via:
 *   - Command Palette (Ctrl+Shift+P) -> "Nexa: ..."
 *   - Editor title bar buttons (Build, Run)
 *   - Right-click context menu
 *   - Keyboard shortcuts (Ctrl+Shift+B = Build, F5 = Run)
 */

const vscode = require('vscode');
const { exec, spawn } = require('child_process');
const path = require('path');

/** @type {vscode.OutputChannel | undefined} */
let outputChannel;

/**
 * Get the nexa executable command. Honors the `nexa.executable` setting.
 * @returns {string}
 */
function getNexaExecutable() {
    const config = vscode.workspace.getConfiguration('nexa');
    return config.get('executable', 'nexa');
}

/**
 * Get the harness mode from settings.
 * @returns {string}
 */
function getHarnessMode() {
    return vscode.workspace.getConfiguration('nexa').get('harnessMode', 'warn');
}

/**
 * Get proxy environment additions for child processes.
 * @returns {Object}
 */
function getProxyEnv() {
    const config = vscode.workspace.getConfiguration('nexa');
    const proxyUrl = config.get('proxyUrl', '');
    const env = Object.assign({}, process.env);
    if (proxyUrl) {
        env.HTTP_PROXY = proxyUrl;
        env.HTTPS_PROXY = proxyUrl;
        env.http_proxy = proxyUrl;
        env.https_proxy = proxyUrl;
    }
    return env;
}

/**
 * Ensure the output channel exists.
 * @returns {vscode.OutputChannel}
 */
function getOutputChannel() {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('Nexa');
    }
    return outputChannel;
}

/**
 * Get the active .nx file path, or prompt the user if none is active.
 * @returns {string | undefined}
 */
function getActiveNexaFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor. Open a .nx file first.');
        return undefined;
    }
    const filePath = editor.document.fileName;
    if (!filePath.endsWith('.nx')) {
        vscode.window.showWarningMessage(`Active file is not a .nx file: ${filePath}`);
        return undefined;
    }
    return filePath;
}

/**
 * Save the active file before running a command.
 * @returns {Promise<void>}
 */
async function saveActiveFile() {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.isDirty) {
        await editor.document.save();
    }
}

/**
 * Run a shell command and stream output to the Nexa output channel.
 * @param {string} cmd - The command string to execute
 * @param {string} cwd - Working directory
 * @returns {Promise<number>} - Exit code
 */
function runCommand(cmd, cwd) {
    return new Promise((resolve) => {
        const channel = getOutputChannel();
        channel.show(true);
        channel.appendLine(`\n$ ${cmd}\n`);

        const env = getProxyEnv();
        const child = exec(cmd, { cwd, env, maxBuffer: 10 * 1024 * 1024 });

        if (child.stdout) {
            child.stdout.on('data', (data) => channel.append(data.toString()));
        }
        if (child.stderr) {
            child.stderr.on('data', (data) => channel.append(data.toString()));
        }
        child.on('close', (code) => {
            channel.appendLine(`\n[exit code: ${code}]\n`);
            resolve(code || 0);
        });
        child.on('error', (err) => {
            channel.appendLine(`\n[error: ${err.message}]\n`);
            resolve(1);
        });
    });
}

/**
 * Build the current .nx file: `nexa build <file>`
 */
async function buildCommand() {
    await saveActiveFile();
    const filePath = getActiveNexaFile();
    if (!filePath) return;

    const nexa = getNexaExecutable();
    const cwd = path.dirname(filePath);
    const cmd = `${nexa} build "${filePath}"`;
    const code = await runCommand(cmd, cwd);
    if (code === 0) {
        vscode.window.showInformationMessage('Nexa: Build succeeded.');
    } else {
        vscode.window.showErrorMessage(`Nexa: Build failed (exit ${code}).`);
    }
}

/**
 * Run the current .nx file: `nexa run <file>`
 */
async function runCommand() {
    await saveActiveFile();
    const filePath = getActiveNexaFile();
    if (!filePath) return;

    const nexa = getNexaExecutable();
    const cwd = path.dirname(filePath);
    const cmd = `${nexa} run "${filePath}"`;
    await runCommand(cmd, cwd);
}

/**
 * Harness check the current .nx file: `nexa harness-check <file>`
 */
async function harnessCheckCommand() {
    await saveActiveFile();
    const filePath = getActiveNexaFile();
    if (!filePath) return;

    const nexa = getNexaExecutable();
    const cwd = path.dirname(filePath);
    const cmd = `${nexa} harness-check "${filePath}" --harness ${getHarnessMode()}`;
    await runCommand(cmd, cwd);
}

/**
 * Validate the current .nx file: `nexa validate <file>`
 */
async function validateCommand() {
    await saveActiveFile();
    const filePath = getActiveNexaFile();
    if (!filePath) return;

    const nexa = getNexaExecutable();
    const cwd = path.dirname(filePath);
    const cmd = `${nexa} validate "${filePath}"`;
    await runCommand(cmd, cwd);
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand('nexa.build', buildCommand),
        vscode.commands.registerCommand('nexa.run', runCommand),
        vscode.commands.registerCommand('nexa.harnessCheck', harnessCheckCommand),
        vscode.commands.registerCommand('nexa.validate', validateCommand),
    );
    getOutputChannel().appendLine('[Nexa Extension] Activated. Commands: nexa.build, nexa.run, nexa.harnessCheck, nexa.validate');
}

function deactivate() {
    if (outputChannel) {
        outputChannel.dispose();
    }
}

module.exports = { activate, deactivate };
