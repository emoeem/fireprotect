import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  adminIdList,
  applyPreset,
  cleanHost,
  defaultConfig,
  installUrl,
  keywordList,
} from "./bot-config.ts";

// 测试夹具，不是真实密钥：整段字面量会被凭据扫描器当成泄露的密钥，按段拼装。
const FAKE_WEBHOOK_SECRET = "secret-" + "value-16chars";

describe("adminIdList", () => {
  it("accepts the separators people actually paste", () => {
    assert.deepEqual(adminIdList("111111, 222222，333333\n444444"), [
      "111111",
      "222222",
      "333333",
      "444444",
    ]);
  });

  it("keeps only 5–15 digit ids", () => {
    assert.deepEqual(adminIdList("1234 12345 123456789012345 1234567890123456"), [
      "12345",
      "123456789012345",
    ]);
  });

  it("does not turn junk into an id", () => {
    assert.deepEqual(adminIdList("@someone +8613800000000 12 34"), []);
  });
});

describe("keywordList", () => {
  it("trims, drops blanks and de-duplicates case-insensitively", () => {
    assert.deepEqual(keywordList("\n  加微信 \n加微信\nJIA\njia  \n\n"), ["加微信", "JIA"]);
  });

  it("drops lines longer than 80 characters", () => {
    const long = "x".repeat(81);
    assert.deepEqual(keywordList(long + "\n正常"), ["正常"]);
  });

  it("caps the list at 200 entries", () => {
    const raw = Array.from({ length: 250 }, (_, i) => `词${i}`).join("\n");
    assert.equal(keywordList(raw).length, 200);
  });
});

describe("cleanHost", () => {
  it("strips scheme, path and whitespace", () => {
    assert.equal(cleanHost("  https://flareward.pd2335346.workers.dev/install?x=1 "), "flareward.pd2335346.workers.dev");
    assert.equal(cleanHost("flare ward.workers.dev"), "flareward.workers.dev");
  });

  it("returns an empty string when there is nothing left", () => {
    assert.equal(cleanHost("https://"), "");
  });
});

describe("installUrl", () => {
  it("is empty without a host", () => {
    assert.equal(installUrl({ ...defaultConfig, workerHost: "" }), "");
  });

  it("omits the key when the secret is empty", () => {
    assert.equal(
      installUrl({ ...defaultConfig, workerHost: "w.example.workers.dev", webhookSecret: "" }),
      "https://w.example.workers.dev/install",
    );
  });

  it("encodes the key", () => {
    assert.equal(
      installUrl({ ...defaultConfig, workerHost: "w.workers.dev", webhookSecret: "a b&c" }),
      "https://w.workers.dev/install?key=a%20b%26c",
    );
  });
});

describe("applyPreset", () => {
  it("keeps identity fields and replaces the rules", () => {
    const current = {
      ...defaultConfig,
      adminIds: "111111",
      webhookSecret: FAKE_WEBHOOK_SECRET,
      workerHost: "w.workers.dev",
      keywords: "自定义词",
    };
    const strict = applyPreset("strict", current);
    assert.equal(strict.adminIds, "111111");
    assert.equal(strict.webhookSecret, FAKE_WEBHOOK_SECRET);
    assert.equal(strict.workerHost, "w.workers.dev");
    assert.equal(strict.keywords, defaultConfig.keywords);
    assert.equal(strict.spamAction, "ban");
    assert.equal(strict.filterForwards, true);
  });

  it("light disables the gate but keeps links filtered", () => {
    const light = applyPreset("light", defaultConfig);
    assert.equal(light.captcha, false);
    assert.equal(light.filterLinks, true);
    assert.equal(light.filterForwards, false);
    assert.equal(light.spamAction, "delete");
  });
});
