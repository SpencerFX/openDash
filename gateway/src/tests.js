"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// Reads the artifacts tests/sh/run_all.sh drops under tests/logs/results/
// (manifest.txt + one <suite>.out per suite) and turns them into structured
// results for the dashboard's Tests page. POST /api/tests/run kicks off a
// fresh run_all.sh in the background - which STOPS the running openQ
// platform (the individual suites tear their own q processes down).

class TestsReader {
  constructor(testsDir) {
    this.testsDir = testsDir; // .../openQ/tests
    this.resultsDir = path.join(testsDir, "logs", "results");
    this.runAllScript = path.join(testsDir, "sh", "run_all.sh");
    this.running = false;
  }

  _read(file) {
    try {
      return fs.readFileSync(path.join(this.resultsDir, file), "utf8").trim();
    } catch {
      return null;
    }
  }

  results() {
    const manifest = this._read("manifest.txt");
    const startedAt = this._read("startedAt");
    const finishedAt = this._read("finishedAt");
    if (!manifest) return { present: false, running: this.running, startedAt, finishedAt };

    const suites = manifest
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [name, code, start, end, durSec] = line.split("|");
        const out = this._read(`${name}.out`) || "";
        const checks = [];
        let pass = 0;
        let fail = 0;
        for (const l of out.split(/\r?\n/)) {
          const m = /^(PASS|FAIL):\s*(.*)$/.exec(l.trim());
          if (!m) continue;
          const ok = m[1] === "PASS";
          checks.push({ ok, name: m[2] });
          ok ? (pass += 1) : (fail += 1);
        }
        const rm = /RESULT:\s*(\d+)\s*passed,\s*(\d+)\s*failed/.exec(out);
        if (rm) {
          pass = Number(rm[1]);
          fail = Number(rm[2]);
        }
        const exitCode = Number(code);
        const errored = !checks.length && exitCode !== 0;
        return {
          name,
          exitCode,
          startedAt: start,
          finishedAt: end,
          durationSec: Number(durSec) || null,
          pass,
          fail,
          errored,
          status: errored ? "error" : fail > 0 ? "fail" : "pass",
          checks,
          tail: out.split(/\r?\n/).slice(-60).join("\n"),
        };
      });

    return {
      present: true,
      running: this.running,
      startedAt,
      finishedAt,
      totals: {
        suites: suites.length,
        green: suites.filter((s) => s.status === "pass").length,
        red: suites.filter((s) => s.status !== "pass").length,
        pass: suites.reduce((a, s) => a + s.pass, 0),
        fail: suites.reduce((a, s) => a + s.fail, 0),
      },
      suites,
    };
  }

  run() {
    if (this.running) return { started: false, reason: "a run is already in progress" };
    if (!fs.existsSync(this.runAllScript)) return { started: false, reason: `not found: ${this.runAllScript}` };
    this.running = true;
    try {
      const child = spawn("bash", [this.runAllScript], {
        cwd: path.dirname(this.runAllScript),
        detached: true,
        stdio: "ignore",
      });
      child.on("exit", () => { this.running = false; });
      child.on("error", () => { this.running = false; });
      child.unref();
      return { started: true };
    } catch (e) {
      this.running = false;
      return { started: false, reason: e.message };
    }
  }

  status() {
    return { enabled: true, dir: this.testsDir, running: this.running, hasResults: !!this._read("manifest.txt") };
  }
}

module.exports = { TestsReader };
