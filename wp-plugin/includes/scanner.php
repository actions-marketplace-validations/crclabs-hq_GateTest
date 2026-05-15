<?php
/**
 * Scan orchestration — runs from the AJAX endpoint and from the cron.
 */

if (!defined('ABSPATH')) {
    exit;
}

/**
 * AJAX handler for the "Scan my site now" button.
 *
 * Wired in the main plugin file:
 *   add_action('wp_ajax_gatetest_hc_run_scan', 'gatetest_hc_handle_run_scan');
 */
function gatetest_hc_handle_run_scan() {
    // Capability + nonce check — required for admin AJAX.
    if (!current_user_can('manage_options')) {
        wp_send_json_error([
            'message' => __('Insufficient permissions.', GATETEST_HC_TEXT_DOMAIN),
        ], 403);
    }

    check_ajax_referer('gatetest_hc_scan', 'nonce');

    $apiKey = get_option('gatetest_hc_api_key', '');
    if (empty($apiKey)) {
        wp_send_json_error([
            'message' => __('GateTest API key is not configured.', GATETEST_HC_TEXT_DOMAIN),
        ], 400);
    }

    $result = gatetest_hc_request_scan($apiKey, home_url(), [
        'full_report' => false, // Free preview by default; full report after the user upgrades.
    ]);

    if (is_wp_error($result)) {
        wp_send_json_error([
            'message' => $result->get_error_message(),
            'code'    => $result->get_error_code(),
        ], 500);
    }

    // Persist the scan summary so the dashboard can show it on next page load.
    update_option('gatetest_hc_last_scan_at', time());
    update_option('gatetest_hc_last_scan_id', isset($result['scanId']) ? sanitize_text_field($result['scanId']) : '');
    set_transient('gatetest_hc_last_result', $result, DAY_IN_SECONDS * 7);

    wp_send_json_success($result);
}

/**
 * Scheduled weekly scan — registered when the user opts in via Settings.
 */
function gatetest_hc_run_scheduled_scan() {
    $consent = get_option('gatetest_hc_consent_url_share', 'false') === 'true';
    if (!$consent) {
        return;
    }
    $apiKey = get_option('gatetest_hc_api_key', '');
    if (empty($apiKey)) {
        return;
    }
    $result = gatetest_hc_request_scan($apiKey, home_url(), [
        'full_report' => true, // Full report on scheduled scans (paid tier).
    ]);
    if (is_wp_error($result)) {
        error_log('[gatetest-hc] Scheduled scan failed: ' . $result->get_error_message());
        return;
    }
    update_option('gatetest_hc_last_scan_at', time());
    update_option('gatetest_hc_last_scan_id', isset($result['scanId']) ? sanitize_text_field($result['scanId']) : '');
    set_transient('gatetest_hc_last_result', $result, DAY_IN_SECONDS * 7);
}

/**
 * Hook into the settings save to (un)schedule the weekly cron.
 */
add_action('update_option_gatetest_hc_consent_url_share', function ($old, $new) {
    if ($new === 'true' && !wp_next_scheduled('gatetest_hc_weekly_scan')) {
        // Run at the next Sunday 3am UTC, then weekly.
        $next_sunday_3am = strtotime('next Sunday 03:00 UTC');
        wp_schedule_event($next_sunday_3am, 'weekly', 'gatetest_hc_weekly_scan');
    } elseif ($new === 'false') {
        wp_clear_scheduled_hook('gatetest_hc_weekly_scan');
    }
}, 10, 2);
