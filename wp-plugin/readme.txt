=== GateTest Health Check ===
Contributors: gatetest
Tags: security, audit, performance, accessibility, seo, malware, plugin scanner
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 0.1.0
License: MIT
License URI: https://opensource.org/licenses/MIT

Audit your WordPress site for security, performance, accessibility, SEO and quality issues. 18 modules, plain-language report. Powered by gatetest.ai.

== Description ==

**GateTest Health Check** runs a comprehensive 18-module audit against your WordPress site and returns a plain-language report.

You probably already use Wordfence for the firewall, Yoast for SEO, WP Rocket for performance, and Sucuri for cleanup. GateTest does NOT replace them — it's the **audit layer that tells you what's actually wrong across all of those concerns in one scan, every week**.

= What it checks =

* Exposed sensitive files (wp-config.php.bak, debug.log, .git, .env, SQL backups)
* WordPress version leak vectors (readme.html, meta generator, RSS feed)
* XML-RPC exposure + pingback DDoS reflector risk
* Plugin CVEs (cross-referenced against a curated 2024-2026 database)
* Active theme abandonment / known theme CVEs
* Malware patterns in your rendered HTML (eval/atob, hidden iframes, base64 payloads)
* Username enumeration vectors (?author=1 redirect, REST API leak)
* Admin login hardening (WAF, 2FA detection, cookie hardening)
* PHP version end-of-life status
* Backup plugin presence + exposed-backup detection
* HTTPS / TLS configuration + missing security headers
* Cookie hardening (HttpOnly, Secure, SESSION_COOKIE_* flags)
* Accessibility issues (WCAG 2.1 AA via axe-core)
* SEO basics (meta, schema.org, sitemap, hreflang)
* Broken links + dead images
* Performance / Core Web Vitals

= What it does NOT do =

* Remove malware (Sucuri's lane)
* Block attackers in real time (Wordfence / Cloudflare's lane)
* Take backups (UpdraftPlus is free; we tell you if you don't have it)

We are the **audit** layer. We tell you exactly what's wrong, where, and how to fix it. The other tools handle the active defence; we make sure they're configured correctly and nothing slipped through.

= How it works =

1. Get a free API key at [gatetest.ai/account](https://gatetest.ai/account)
2. Paste the key into the GateTest tab under **Tools** in WordPress
3. Click "Scan my site now"
4. Read the report

The scan runs on gatetest.ai's infrastructure — your site is probed over HTTP from outside, same way an attacker would see it. No source code is sent to us; only your site's URL and WordPress version.

= Pricing =

The free preview shows the top 3 most urgent findings. To see the full report, opt into auto-fix, or enable weekly scheduled scans, you'll need a paid GateTest plan starting at $29/month. Full pricing: [gatetest.ai/pricing](https://gatetest.ai/pricing).

== Installation ==

1. Upload the `gatetest-health-check` plugin to the `/wp-content/plugins/` directory, or install through the WordPress plugin directory.
2. Activate the plugin through the **Plugins** menu in WordPress.
3. Go to **Tools → GateTest** to configure your API key and run your first scan.

== Frequently Asked Questions ==

= Does this plugin slow down my site? =

No. The scan runs on gatetest.ai's servers — not yours. Your site experiences the same network traffic as a regular visitor making a few HTTP requests. There are no background processes, no continuous monitoring loops, and the plugin file weighs less than 50KB.

= What data is sent to gatetest.ai? =

Your site's public URL, your WordPress version, and your GateTest API key. No source code, no database content, no credentials, no plugin list, no theme data. The scan probes your site from the outside.

= Is the free preview enough? =

For most sites, the free preview surfaces the top 3 most urgent findings. That's enough to know whether you need to dig deeper. If everything looks clean in the free preview, you probably don't need to pay for the full report.

= How does this compare to Wordfence? =

Wordfence is a firewall — it blocks attacks in real time. GateTest is an audit — it tells you what's wrong before you get attacked. Use both. They don't overlap.

== Changelog ==

= 0.1.0 =
* Initial release. Scaffold for the GateTest Health Check companion plugin.
* Includes admin page under Tools → GateTest, API client, scheduled weekly scan, basic report rendering.

== Privacy ==

Full privacy policy at [gatetest.ai/legal/privacy](https://gatetest.ai/legal/privacy).
