<?php
/**
 * Thin HTTP client for the gatetest.ai scan API.
 *
 * All scan work runs server-side at gatetest.ai. This file just packs the
 * site's URL + api_key into a POST request, parses the JSON response, and
 * returns it. No business logic.
 */

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Request a scan from gatetest.ai.
 *
 * @param string $api_key The customer's GateTest API key.
 * @param string $site_url The site URL to scan (typically home_url()).
 * @param array  $opts Optional. { full_report?: bool, tier?: string }
 *
 * @return array|WP_Error Decoded JSON response on success, WP_Error on transport / auth failure.
 */
function gatetest_hc_request_scan($api_key, $site_url, $opts = []) {
    if (empty($api_key)) {
        return new WP_Error(
            'gatetest_hc_no_api_key',
            __('GateTest API key is missing.', GATETEST_HC_TEXT_DOMAIN)
        );
    }
    if (empty($site_url) || !filter_var($site_url, FILTER_VALIDATE_URL)) {
        return new WP_Error(
            'gatetest_hc_invalid_url',
            __('Site URL is invalid.', GATETEST_HC_TEXT_DOMAIN)
        );
    }

    $body = wp_json_encode([
        'url'         => $site_url,
        'fullReport'  => !empty($opts['full_report']),
        'source'      => 'wordpress-plugin',
        'wpVersion'   => get_bloginfo('version'),
        'pluginVersion' => GATETEST_HC_VERSION,
    ]);

    $response = wp_remote_post(GATETEST_HC_API_BASE . '/api/wp/scan', [
        'timeout'     => 90, // Server-side scan can take 30-60s.
        'headers'     => [
            'Content-Type'  => 'application/json',
            'Accept'        => 'application/json',
            'Authorization' => 'Bearer ' . $api_key,
            'User-Agent'    => 'gatetest-health-check/' . GATETEST_HC_VERSION . '; WordPress/' . get_bloginfo('version'),
        ],
        'body'        => $body,
        'data_format' => 'body',
    ]);

    if (is_wp_error($response)) {
        return $response;
    }

    $status = wp_remote_retrieve_response_code($response);
    $body   = wp_remote_retrieve_body($response);
    $json   = json_decode($body, true);

    if ($status === 401 || $status === 403) {
        return new WP_Error(
            'gatetest_hc_auth_failed',
            __('GateTest API rejected the API key. Regenerate it at gatetest.ai/account.', GATETEST_HC_TEXT_DOMAIN),
            ['status' => $status]
        );
    }

    if ($status === 402) {
        return new WP_Error(
            'gatetest_hc_payment_required',
            __('You have insufficient credit for this scan. Top up at gatetest.ai/account.', GATETEST_HC_TEXT_DOMAIN),
            ['status' => $status, 'response' => $json]
        );
    }

    if ($status >= 400) {
        $message = is_array($json) && !empty($json['error'])
            ? $json['error']
            : __('Scan failed.', GATETEST_HC_TEXT_DOMAIN);
        return new WP_Error(
            'gatetest_hc_scan_failed',
            $message,
            ['status' => $status, 'response' => $json]
        );
    }

    if (!is_array($json)) {
        return new WP_Error(
            'gatetest_hc_bad_response',
            __('GateTest returned an unparseable response.', GATETEST_HC_TEXT_DOMAIN)
        );
    }

    return $json;
}
