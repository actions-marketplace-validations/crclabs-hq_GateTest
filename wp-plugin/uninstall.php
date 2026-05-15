<?php
/**
 * GateTest Health Check — Uninstall cleanup.
 *
 * Runs when the user clicks "Delete" on the plugin in the WordPress admin.
 * Cleans up all plugin-created options + transients + scheduled events.
 *
 * NOTE: scans are tracked on gatetest.ai's side (linked to the customer's
 * API key); uninstalling the plugin does NOT delete the customer's account
 * or scan history. Customer manages that at gatetest.ai/account.
 */

if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}

delete_option('gatetest_hc_api_key');
delete_option('gatetest_hc_last_scan_at');
delete_option('gatetest_hc_last_scan_id');
delete_option('gatetest_hc_consent_url_share');

delete_transient('gatetest_hc_last_result');

if (function_exists('wp_clear_scheduled_hook')) {
    wp_clear_scheduled_hook('gatetest_hc_weekly_scan');
}
