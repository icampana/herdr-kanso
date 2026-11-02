import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./helpers.mjs";

function psLiteral(text) {
  assert.equal(text[0], "'");
  let value = "", i = 1;
  const quotes = "'‘’‚‛";
  for (; i < text.length; i++) {
    const ch = text[i];
    if (!quotes.includes(ch)) value += ch;
    else if (quotes.includes(text[i + 1] ?? "\0")) { value += ch; i++; }
    else return { value, rest: text.slice(i + 1) };
  }
  assert.fail("Unterminated PowerShell literal");
}

test("Windows launch keeps all PowerShell single quotes inside literals", async () => {
  let command;
  const { OpenWith } = await load("open-with/main.js", ["OpenWith"], {
    exec: async (_program, args) => { command = args.at(-1); return { code: 0 }; },
  });
  const view = new OpenWith(); view.platform = "windows";
  for (const quote of "'‘’‚‛") {
    const path = `C:\\repo\\report${quote}); Write-Output marker; #.txt`;
    const cli = `C:\\Users\\O${quote}Brien\\editor.exe`;
    await view.spawn(cli, [path]);
    const executable = psLiteral(command.slice("Start-Process -FilePath ".length));
    assert.equal(executable.value, cli);
    assert.ok(executable.rest.startsWith(" -ArgumentList "));
    const argument = psLiteral(executable.rest.slice(" -ArgumentList ".length));
    assert.equal(argument.value, `"${path}"`);
    assert.equal(argument.rest, " -ErrorAction Stop");
  }
});

test("Windows arguments retain spaces, empty strings, quotes and trailing slashes", async () => {
  let command;
  const { OpenWith } = await load("open-with/main.js", ["OpenWith"], {
    exec: async (_program, args) => { command = args.at(-1); return { code: 0 }; },
  });
  const view = new OpenWith(); view.platform = "windows";
  await view.spawn("editor.exe", ["--remote", "ssh-remote+host", "C:\\My Project\\", "", 'a"b', 'a\\"b']);
  const executable = psLiteral(command.slice("Start-Process -FilePath ".length));
  const argument = psLiteral(executable.rest.slice(" -ArgumentList ".length));
  assert.equal(argument.value, String.raw`"--remote" "ssh-remote+host" "C:\My Project\\" "" "a\"b" "a\\\"b"`);
  for (const invalid of ["a\0b", "a\rb", "a\nb"]) {
    assert.throws(() => view.spawn("editor.exe", [invalid]), /Invalid path/);
  }
});
