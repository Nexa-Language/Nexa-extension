/**
 * Nexa Language Extension for VSCode
 *
 * Provides syntax highlighting + one-click Build/Run/HarnessCheck/Validate commands.
 * Commands: nexa.build, nexa.run, nexa.harnessCheck, nexa.validate
 * Shortcuts: Ctrl+Shift+B (build), F5 (run)
 */

const vscode = require('vscode');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

let outputChannel;

function getOutputChannel() {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('Nexa');
    }
    return outputChannel;
}

function getNexaExecutable() {
    return vscode.workspace.getConfiguration('nexa').get('executable', 'nexa');
}

function getHarnessMode() {
    return vscode.workspace.getConfiguration('nexa').get('harnessMode', 'warn');
}

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

function log(msg) {
    const ch = getOutputChannel();
    ch.appendLine(msg);
    ch.show(true);
}

/**
 * Parse the nexa executable setting into (cmd, args[]).
 * Supports both 'nexa' and 'python -m src.cli' style.
 */
function parseExecutable(setting) {
    const parts = setting.split(/\s+/).filter(Boolean);
    return { cmd: parts[0], prefixArgs: parts.slice(1) };
}

/**
 * Run nexa subcommand via execFile (no shell, safe arg passing).
 * @returns {Promise<number>} exit code
 */
function runNexa(subArgs, cwd) {
    return new Promise((resolve) => {
        const { cmd, prefixArgs } = parseExecutable(getNexaExecutable());
        const args = [...prefixArgs, ...subArgs];
        const env = getProxyEnv();

        log(`\n$ ${cmd} ${args.join(' ')}  (cwd: ${cwd})\n`);

        const child = execFile(cmd, args, {
            cwd,
            env,
            maxBuffer: 10 * 1024 * 1024,
            shell: process.platform === 'win32',  // shell needed on Windows for PATH lookup
        });

        if (child.stdout) {
            child.stdout.on('data', (data) => {
                getOutputChannel().append(data.toString());
            });
        }
        if (child.stderr) {
            child.stderr.on('data', (data) => {
                getOutputChannel().append(data.toString());
            });
        }
        child.on('close', (code) => {
            log(`\n[exit code: ${code}]\n`);
            resolve(code || 0);
        });
        child.on('error', (err) => {
            log(`\n[error: ${err.message}]`);
            if (err.code === 'ENOENT') {
                log(`Hint: '${cmd}' not found. Set "nexa.executable" in Settings to the full path.`);
            }
            resolve(1);
        });
    });
}

function getActiveNexaFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('Nexa: No active editor. Open a .nx file first.');
        return undefined;
    }
    const filePath = editor.document.fileName;
    if (!filePath.endsWith('.nx')) {
        vscode.window.showWarningMessage(`Nexa: Active file is not a .nx file: ${filePath}`);
        return undefined;
    }
    return filePath;
}

async function saveActiveFile() {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.isDirty) {
        await editor.document.save();
    }
}

async function buildCommand() {
    log('>>> nexa.build command triggered');
    await saveActiveFile();
    const filePath = getActiveNexaFile();
    if (!filePath) return;
    const cwd = path.dirname(filePath);
    const code = await runNexa(['build', filePath], cwd);
    if (code === 0) {
        vscode.window.showInformationMessage('Nexa: Build succeeded.');
    } else {
        vscode.window.showErrorMessage(`Nexa: Build failed (exit ${code}). See Output panel.`);
    }
}

async function runCommand() {
    log('>>> nexa.run command triggered');
    await saveActiveFile();
    const filePath = getActiveNexaFile();
    if (!filePath) return;
    const cwd = path.dirname(filePath);
    await runNexa(['run', filePath], cwd);
}

async function harnessCheckCommand() {
    log('>>> nexa.harnessCheck command triggered');
    await saveActiveFile();
    const filePath = getActiveNexaFile();
    if (!filePath) return;
    const cwd = path.dirname(filePath);
    await runNexa(['harness-check', filePath, '--harness', getHarnessMode()], cwd);
}

async function validateCommand() {
    log('>>> nexa.validate command triggered');
    await saveActiveFile();
    const filePath = getActiveNexaFile();
    if (!filePath) return;
    const cwd = path.dirname(filePath);
    await runNexa(['validate', filePath], cwd);
}

function activate(context) {
    log('[Nexa Extension] Activating...');
    context.subscriptions.push(
        vscode.commands.registerCommand('nexa.build', buildCommand),
        vscode.commands.registerCommand('nexa.run', runCommand),
        vscode.commands.registerCommand('nexa.harnessCheck', harnessCheckCommand),
        vscode.commands.registerCommand('nexa.validate', validateCommand),
    );
    log('[Nexa Extension] Activated. Commands registered: nexa.build, nexa.run, nexa.harnessCheck, nexa.validate');
}

function deactivate() {
    if (outputChannel) {
        outputChannel.dispose();
    }
}

module.exports = { activate, deactivate };
