/**
 * GateTest Health Check — admin page JS.
 * Handles the "Scan my site now" button + report rendering.
 */
(function ($) {
    'use strict';

    $(function () {
        var $btn = $('#gatetest-hc-run-scan');
        var $status = $('#gatetest-hc-scan-status');
        var $report = $('#gatetest-hc-report');

        if (!$btn.length) {
            return;
        }

        $btn.on('click', function (e) {
            e.preventDefault();
            $btn.prop('disabled', true);
            $status.attr('class', 'gatetest-hc-status is-scanning').text(
                'Probing your site… this usually takes 20-60 seconds.'
            );
            $report.empty();

            $.post(window.gatetestHc.ajaxUrl, {
                action: 'gatetest_hc_run_scan',
                nonce: window.gatetestHc.nonce
            })
                .done(function (response) {
                    $btn.prop('disabled', false);
                    if (!response || !response.success) {
                        $status.attr('class', 'gatetest-hc-status is-error').text(
                            'Scan failed: ' + (response && response.data && response.data.message
                                ? response.data.message
                                : 'unknown error')
                        );
                        return;
                    }
                    renderReport(response.data);
                })
                .fail(function (xhr) {
                    $btn.prop('disabled', false);
                    var message = 'Network error.';
                    if (xhr && xhr.responseJSON && xhr.responseJSON.data && xhr.responseJSON.data.message) {
                        message = xhr.responseJSON.data.message;
                    }
                    $status.attr('class', 'gatetest-hc-status is-error').text('Scan failed: ' + message);
                });
        });

        function renderReport(data) {
            var findings = (data && Array.isArray(data.findings)) ? data.findings : [];
            var summary = {
                errors: data.errorCount || 0,
                warnings: data.warningCount || 0,
                info: data.infoCount || 0,
                total: data.totalFindings || findings.length
            };

            $status
                .attr('class', 'gatetest-hc-status is-success')
                .text(
                    'Scan complete. Found ' + summary.errors + ' error(s), ' +
                    summary.warnings + ' warning(s).'
                );

            if (findings.length === 0) {
                $report.html(
                    '<p><strong>Nothing major found.</strong> ' +
                    'Your site passed every check in the free-preview tier. ' +
                    'Upgrade to see the full report.</p>'
                );
                return;
            }

            var html = '';
            findings.forEach(function (f) {
                var severityClass = 'severity-' + (f.severity || 'info');
                html += '<div class="gatetest-hc-finding ' + severityClass + '">';
                html += '<div class="gatetest-hc-finding-title">' + escapeHtml(f.title || '(untitled)') + '</div>';
                html += '<div class="gatetest-hc-finding-body">' + escapeHtml(f.body || '') + '</div>';
                html += '</div>';
            });

            if (data.preview && data.paywall && data.paywall.remainingCount > 0) {
                html += '<div class="gatetest-hc-paywall">';
                html += '<h3>' + data.paywall.remainingCount + ' more finding(s) hidden in the free preview</h3>';
                html += '<p>Upgrade to GateTest Starter ($29/mo) to see them all + get auto-fix.</p>';
                html += '<p><a href="https://gatetest.ai/pricing?from=wp-plugin" target="_blank" rel="noopener" class="button button-primary">See pricing</a></p>';
                html += '</div>';
            }

            $report.html(html);
        }

        function escapeHtml(s) {
            if (typeof s !== 'string') {
                s = String(s == null ? '' : s);
            }
            return s
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }
    });
})(jQuery);
