# frozen_string_literal: true

# ============================================================================
# GATETEST HOMEBREW FORMULA — PROTECTED FILE
# ============================================================================
# Drop into a tap repo (e.g. ccantynz-alt/homebrew-gatetest) so users can:
#
#   brew tap ccantynz-alt/gatetest
#   brew install gatetest
#
# After every npm publish, regenerate the URL + sha256 below. The publish
# playbook (integrations/marketplace/PUBLISHING.md) shows the one-liner.
# ============================================================================

class Gatetest < Formula
  desc "Unified quality gate for AI-generated code — 90 modules, one decision"
  homepage "https://gatetest.ai"
  url "https://registry.npmjs.org/gatetest/-/gatetest-1.0.0.tgz"
  sha256 "REPLACE_WITH_TARBALL_SHA256_AFTER_PUBLISH"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "GateTest", shell_output("#{bin}/gatetest --version")
  end
end
