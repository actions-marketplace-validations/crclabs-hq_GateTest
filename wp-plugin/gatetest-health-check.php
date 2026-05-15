<?php
/**
 * Plugin Name:       GateTest Health Check
 * Plugin URI:        https://gatetest.ai
 * Description:       Audit your WordPress site for 18+ security, performance, and quality issues. Plain-language report. Powered by the GateTest engine.
 * Version:           0.1.0
 * Requires at least: 6.0
 * Tested up to:      6.7
 * Requires PHP:      7.4
 * Author:            GateTest
 * Author URI:        https://gatetest.ai
 * License:           MIT
 * License URI:       https://opensource.org/licenses/MIT
 * Text Domain:       gatetest-health-check
 * Domain Path:       /languages
 *
 * GateTest Health Check is a thin client for the gatetest.ai scan engine.
 * It does NOT do the scanning locally — that runs at gatetest.ai. This plugin:
 *
 *   1. Adds an admin menu page under Tools → GateTest
 *   2. Captures the site's identifying info (URL, WP version, theme, plugins)
 *   3. Sends a scan request to https://gatetest.ai/api/wp/scan
 *   4. Renders the plain-language report inside the admin UI
 *
 * No source code is sent. The scan probes the site over HTTP from gatetest.ai's
 * infrastructure — same way a customer running a manual scan on the website
 * would experience it. Plugin acts as the convenient launcher + result viewer.
 *
 * Privacy: site URL + WP version are sent. No content, no credentials, no
 * database data. See https://gatetest.ai/legal/privacy for the full data
 * handling contract.
 *
 * Pre-authorisation: Craig 2026-05-13 — WordPress side product Boss Rule D.
 */

// Block direct access — required for WP.org directory compliance.
if (!defined('ABSPATH')) {
    exit;
}

define('GATETEST_HC_VERSION', '0.1.0');
define('GATETEST_HC_PLUGIN_DIR', plugin_dir_path(__FILE__));
define('GATETEST_HC_PLUGIN_URL', plugin_dir_url(__FILE__));
define('GATETEST_HC_API_BASE', 'https://gatetest.ai');
define('GATETEST_HC_TEXT_DOMAIN', 'gatetest-health-check');

// Load includes.
require_once GATETEST_HC_PLUGIN_DIR . 'includes/admin-page.php';
require_once GATETEST_HC_PLUGIN_DIR . 'includes/scanner.php';
require_once GATETEST_HC_PLUGIN_DIR . 'includes/api-client.php';

/**
 * Plugin activation — runs once on install.
 *
 * Creates the default options. No DB tables yet — scan results live in
 * a single transient + options entry per scan; if the customer wants
 * historical comparison they upgrade to the paid Continuous tier
 * where results live in our cloud.
 */
function gatetest_hc_activate() {
    add_option('gatetest_hc_last_scan_at', 0);
    add_option('gatetest_hc_last_scan_id', '');
    add_option('gatetest_hc_api_key', ''); // Set by the user via Settings page.
    add_option('gatetest_hc_consent_url_share', 'false');
}
register_activation_hook(__FILE__, 'gatetest_hc_activate');

/**
 * Plugin deactivation — clears scheduled scans + transients.
 */
function gatetest_hc_deactivate() {
    wp_clear_scheduled_hook('gatetest_hc_weekly_scan');
    delete_transient('gatetest_hc_last_result');
}
register_deactivation_hook(__FILE__, 'gatetest_hc_deactivate');

/**
 * Boot the admin UI when WordPress loads admin pages.
 */
add_action('admin_menu', 'gatetest_hc_register_admin_menu');
add_action('admin_init', 'gatetest_hc_register_settings');
add_action('admin_enqueue_scripts', 'gatetest_hc_enqueue_assets');

/**
 * AJAX endpoint — kick off a scan from the admin button.
 */
add_action('wp_ajax_gatetest_hc_run_scan', 'gatetest_hc_handle_run_scan');

/**
 * Weekly scheduled scan — only runs for users on the Continuous tier
 * (validated server-side by the API; this just fires the request).
 */
add_action('gatetest_hc_weekly_scan', 'gatetest_hc_run_scheduled_scan');
