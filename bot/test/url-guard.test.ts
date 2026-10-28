import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { publicHttpUrl } from "../src/url-guard.ts";

/** The guard is a security boundary for everything that reaches argv or fetch. */
describe("publicHttpUrl", () => {
  it("passes public http(s) URLs through unchanged", () => {
    assert.equal(publicHttpUrl("https://b23.tv/abc"), "https://b23.tv/abc");
    assert.equal(publicHttpUrl("http://example.com/a?b=1"), "http://example.com/a?b=1");
    assert.equal(publicHttpUrl("https://1.1.1.1/x"), "https://1.1.1.1/x");
    assert.equal(publicHttpUrl("https://[2606:4700::1111]/x"), "https://[2606:4700::1111]/x");
  });

  it("promotes a bare host/path to https", () => {
    assert.equal(publicHttpUrl("b23.tv/abc"), "https://b23.tv/abc");
    assert.equal(publicHttpUrl("example.com"), "https://example.com");
  });

  it("rejects anything that could be parsed as a CLI flag", () => {
    assert.equal(publicHttpUrl("--exec=touch /tmp/pwned"), null);
    assert.equal(publicHttpUrl("-J"), null);
  });

  it("rejects non-http schemes", () => {
    assert.equal(publicHttpUrl("javascript:alert(1)"), null);
    assert.equal(publicHttpUrl("file:///etc/passwd"), null);
    assert.equal(publicHttpUrl("ftp://example.com/x"), null);
  });

  it("rejects loopback, private and reserved hosts", () => {
    for (const host of [
      "localhost/x",
      "shop.localhost/x",
      "camera.local/x",
      "service.internal/x",
      "127.0.0.1/x",
      "10.1.2.3/x",
      "172.16.0.9/x",
      "172.31.255.1/x",
      "192.168.1.1/x",
      "169.254.169.254/latest/meta-data",
      "100.64.0.1/x",
      "0.0.0.0/x",
      "224.0.0.1/x",
      "[::1]/x",
      "[::ffff:127.0.0.1]/x",
      "[fc00::1]/x",
      "[fe80::1]/x",
    ]) {
      assert.equal(publicHttpUrl(`https://${host}`), null, host);
    }
  });

  it("a trailing dot does not bypass the IPv4 checks", () => {
    assert.equal(publicHttpUrl("https://127.0.0.1./x"), null);
    assert.equal(publicHttpUrl("https://192.168.1.1./x"), null);
  });

  it("rejects credentials in the URL and malformed input", () => {
    assert.equal(publicHttpUrl("https://user:pass@example.com/x"), null);
    assert.equal(publicHttpUrl(""), null);
    assert.equal(publicHttpUrl("   "), null);
    assert.equal(publicHttpUrl("https://"), null);
  });
});
