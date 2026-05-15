<?php
/**
 * Admin UI for GateTest Health Check.
 *
 * Renders the page at Tools → GateTest. Three sections:
 *   1. Run-scan button + status
 *   2. Latest report (if any), rendered as plain-language cards
 *   3. Settings (API key, opt-in to weekly scan)
 */

if (!defined('ABSPATH')) {
    exit;
}

function gatetest_hc_register_admin_menu() {
    add_management_page(
        __('GateTest Health Check', GATETEST_HC_TEXT_DOMAIN),
        __('GateTest', GATETEST_HC_TEXT_DOMAIN),
        'manage_options',
        'gatetest-health-check',
        'gatetest_hc_render_admin_page'
    );
}

function gatetest_hc_register_settings() {
    register_setting('gatetest_hc_settings', 'gatetest_hc_api_key', [
        'type'              => 'string',
        'sanitize_callback' => 'sanitize_text_field',
        'default'           => '',
    ]);
    register_setting('gatetest_hc_settings', 'gatetest_hc_consent_url_share', [
        'type'              => 'string',
        'sanitize_callback' => 'sanitize_text_field',
        'default'           => 'false',
    ]);
}

function gatetest_hc_enqueue_assets($hook) {
    if ($hook !== 'tools_page_gatetest-health-check') {
        return;
    }
    wp_enqueue_style(
        'gatetest-hc-admin',
        GATETEST_HC_PLUGIN_URL . 'assets/css/admin.css',
        [],
        GATETEST_HC_VERSION
    );
    wp_enqueue_script(
        'gatetest-hc-admin',
        GATETEST_HC_PLUGIN_URL . 'assets/js/admin.js',
        ['jquery'],
        GATETEST_HC_VERSION,
        true
    );
    wp_localize_script('gatetest-hc-admin', 'gatetestHc', [
        'ajaxUrl' => admin_url('admin-ajax.php'),
        'nonce'   => wp_create_nonce('gatetest_hc_scan'),
        'siteUrl' => home_url(),
    ]);
}

function gatetest_hc_render_admin_page() {
    if (!current_user_can('manage_options')) {
        wp_die(__('You do not have permission to access this page.', GATETEST_HC_TEXT_DOMAIN));
    }

    $apiKey       = get_option('gatetest_hc_api_key', '');
    $lastScanAt   = (int) get_option('gatetest_hc_last_scan_at', 0);
    $lastResult   = get_transient('gatetest_hc_last_result');
    $consentShare = get_option('gatetest_hc_consent_url_share', 'false') === 'true';
    ?>
    <div class="wrap gatetest-hc-wrap">
        <h1>
            <span class="gatetest-hc-logo">GateTest</span>
            <?php esc_html_e('Health Check', GATETEST_HC_TEXT_DOMAIN); ?>
        </h1>
        <p class="gatetest-hc-tagline">
            <?php esc_html_e('Audit your site for security, performance, and quality issues. 18 modules, plain-language report.', GATETEST_HC_TEXT_DOMAIN); ?>
        </p>

        <div class="gatetest-hc-panels">
            <div class="gatetest-hc-panel gatetest-hc-panel-primary">
                <h2><?php esc_html_e('Run a scan', GATETEST_HC_TEXT_DOMAIN); ?></h2>
                <p>
                    <?php
                    esc_html_e(
                        'GateTest will probe your public URL from gatetest.ai and report any issues found. No source code or credentials are sent.',
                        GATETEST_HC_TEXT_DOMAIN
                    );
                    ?>
                </p>
                <p class="gatetest-hc-site-info">
                    <strong><?php esc_html_e('Site URL to scan:', GATETEST_HC_TEXT_DOMAIN); ?></strong>
                    <code><?php echo esc_html(home_url()); ?></code>
                </p>

                <?php if (empty($apiKey)): ?>
                    <p class="gatetest-hc-warning">
                        <?php
                        printf(
                            /* translators: %s: gatetest.ai signup URL */
                            esc_html__('You need a GateTest API key. %s to get one (free, takes 60 seconds).', GATETEST_HC_TEXT_DOMAIN),
                            '<a href="' . esc_url(GATETEST_HC_API_BASE . '/account?from=wp-plugin') . '" target="_blank" rel="noopener">' .
                            esc_html__('Sign up at gatetest.ai', GATETEST_HC_TEXT_DOMAIN) .
                            '</a>'
                        );
                        ?>
                    </p>
                <?php else: ?>
                    <button id="gatetest-hc-run-scan" class="button button-primary button-hero">
                        <?php esc_html_e('Scan my site now', GATETEST_HC_TEXT_DOMAIN); ?>
                    </button>
                    <div id="gatetest-hc-scan-status" class="gatetest-hc-status"></div>
                <?php endif; ?>
            </div>

            <?php if ($lastResult): ?>
                <div class="gatetest-hc-panel">
                    <h2><?php esc_html_e('Latest report', GATETEST_HC_TEXT_DOMAIN); ?></h2>
                    <p class="gatetest-hc-last-scan-time">
                        <?php
                        printf(
                            /* translators: %s: human-readable time */
                            esc_html__('Last scanned %s', GATETEST_HC_TEXT_DOMAIN),
                            esc_html(human_time_diff($lastScanAt) . ' ago')
                        );
                        ?>
                    </p>
                    <div id="gatetest-hc-report" class="gatetest-hc-report"></div>
                </div>
            <?php endif; ?>

            <div class="gatetest-hc-panel">
                <h2><?php esc_html_e('Settings', GATETEST_HC_TEXT_DOMAIN); ?></h2>
                <form method="post" action="options.php">
                    <?php settings_fields('gatetest_hc_settings'); ?>
                    <table class="form-table">
                        <tr>
                            <th scope="row">
                                <label for="gatetest_hc_api_key">
                                    <?php esc_html_e('API Key', GATETEST_HC_TEXT_DOMAIN); ?>
                                </label>
                            </th>
                            <td>
                                <input
                                    type="text"
                                    id="gatetest_hc_api_key"
                                    name="gatetest_hc_api_key"
                                    value="<?php echo esc_attr($apiKey); ?>"
                                    class="regular-text"
                                    autocomplete="off"
                                />
                                <p class="description">
                                    <?php
                                    printf(
                                        /* translators: %s: link to gatetest.ai/account */
                                        esc_html__('Find or generate yours at %s.', GATETEST_HC_TEXT_DOMAIN),
                                        '<a href="' . esc_url(GATETEST_HC_API_BASE . '/account?from=wp-plugin') . '" target="_blank" rel="noopener">gatetest.ai/account</a>'
                                    );
                                    ?>
                                </p>
                            </td>
                        </tr>
                        <tr>
                            <th scope="row">
                                <label for="gatetest_hc_consent_url_share">
                                    <?php esc_html_e('Weekly auto-scan', GATETEST_HC_TEXT_DOMAIN); ?>
                                </label>
                            </th>
                            <td>
                                <label>
                                    <input
                                        type="checkbox"
                                        id="gatetest_hc_consent_url_share"
                                        name="gatetest_hc_consent_url_share"
                                        value="true"
                                        <?php checked($consentShare); ?>
                                    />
                                    <?php esc_html_e('Run a scan automatically every Sunday at 3am UTC.', GATETEST_HC_TEXT_DOMAIN); ?>
                                </label>
                                <p class="description">
                                    <?php esc_html_e('Requires the GateTest Starter plan or higher.', GATETEST_HC_TEXT_DOMAIN); ?>
                                </p>
                            </td>
                        </tr>
                    </table>
                    <?php submit_button(); ?>
                </form>
            </div>
        </div>

        <p class="gatetest-hc-footer">
            <?php esc_html_e('Powered by the GateTest engine.', GATETEST_HC_TEXT_DOMAIN); ?>
            <a href="<?php echo esc_url(GATETEST_HC_API_BASE); ?>" target="_blank" rel="noopener">gatetest.ai</a>
            ·
            <a href="<?php echo esc_url(GATETEST_HC_API_BASE . '/legal/privacy'); ?>" target="_blank" rel="noopener">
                <?php esc_html_e('Privacy policy', GATETEST_HC_TEXT_DOMAIN); ?>
            </a>
        </p>
    </div>
    <?php
}
