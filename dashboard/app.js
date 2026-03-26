/* ============================================
   PingBase Dashboard — App Logic
   Plain JS. No framework. No build step.
   JWT auth via Bearer token.
   ============================================ */

(function () {
  'use strict';

  // --------------- Config ---------------

  var API_BASE = window.PINGBASE_API_BASE || '/api';
  var REFRESH_INTERVAL = 30000; // 30 seconds

  // --------------- State ---------------

  var state = {
    token: null,
    email: null,
    tier: null,
    monitors: [],
    currentMonitor: null,
    checks: [],
    refreshTimer: null
  };

  // --------------- API Client ---------------

  function apiHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + state.token
    };
  }

  function api(method, path, body) {
    var opts = {
      method: method,
      headers: apiHeaders()
    };
    if (body) {
      opts.body = JSON.stringify(body);
    }
    return fetch(API_BASE + path, opts).then(function (res) {
      if (res.status === 401) {
        // Token expired or invalid — force re-login
        logout();
        throw new Error('Session expired. Please sign in again.');
      }
      if (!res.ok) {
        return res.text().then(function (text) {
          var msg;
          try { msg = JSON.parse(text).error; } catch (e) { msg = text; }
          throw new Error(msg || 'Request failed (' + res.status + ')');
        });
      }
      if (res.status === 204) return null;
      return res.json();
    });
  }

  // --------------- Auth ---------------

  function logout() {
    localStorage.removeItem('pingbase_token');
    localStorage.removeItem('pingbase_email');
    localStorage.removeItem('pingbase_tier');
    stopAutoRefresh();
    window.location.href = 'login.html';
  }

  // --------------- Toast ---------------

  function showToast(message, type) {
    var container = document.getElementById('toast-container');
    var el = document.createElement('div');
    el.className = 'toast ' + (type || 'error');
    el.textContent = message;
    container.appendChild(el);
    setTimeout(function () {
      el.remove();
    }, 4000);
  }

  // --------------- Routing ---------------

  function getRoute() {
    var hash = window.location.hash || '#/';
    if (hash.indexOf('#/monitor/') === 0) {
      return { view: 'detail', id: hash.replace('#/monitor/', '') };
    }
    if (hash === '#/billing') {
      return { view: 'billing' };
    }
    return { view: 'list' };
  }

  function navigate(hash) {
    window.location.hash = hash;
  }

  // --------------- Time Helpers ---------------

  function timeAgo(dateStr) {
    if (!dateStr) return 'Never';
    var diff = Date.now() - new Date(dateStr).getTime();
    var secs = Math.floor(diff / 1000);
    if (secs < 60) return secs + 's ago';
    var mins = Math.floor(secs / 60);
    if (mins < 60) return mins + 'm ago';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    return days + 'd ago';
  }

  function formatTime(dateStr) {
    if (!dateStr) return '-';
    var d = new Date(dateStr);
    return d.toLocaleString();
  }

  // --------------- Render: Monitor List ---------------

  function renderList() {
    var main = document.getElementById('app-content');
    var html = '';

    html += '<div class="toolbar">';
    html += '  <h2>Monitors</h2>';
    html += '  <div>';
    html += '    <button class="btn btn-secondary btn-sm" id="btn-billing" style="margin-right:0.5rem;">Billing</button>';
    html += '    <button class="btn btn-primary" id="btn-add-monitor">+ Add Monitor</button>';
    html += '  </div>';
    html += '</div>';

    if (state.monitors.length === 0) {
      html += '<div class="empty-state">';
      html += '  <p>No monitors yet. Add your first one to get started.</p>';
      html += '</div>';
    } else {
      html += '<div class="monitor-list">';
      state.monitors.forEach(function (m) {
        var status = (m.current_status || 'unknown').toLowerCase();
        var responseTime = m.last_response_time_ms != null ? m.last_response_time_ms + 'ms' : '-';
        html += '<div class="monitor-card" data-id="' + m.id + '">';
        html += '  <span class="status-dot ' + status + '"></span>';
        html += '  <div class="monitor-info">';
        html += '    <div class="monitor-name">' + escapeHtml(m.name) + '</div>';
        html += '    <div class="monitor-url">' + escapeHtml(m.url) + '</div>';
        html += '  </div>';
        html += '  <div class="monitor-meta">';
        html += '    <div class="monitor-response-time">' + responseTime + '</div>';
        html += '    <div class="monitor-last-check">' + timeAgo(m.last_checked_at) + '</div>';
        html += '  </div>';
        html += '  <span class="status-badge ' + status + '">' + status + '</span>';
        html += '</div>';
      });
      html += '</div>';
    }

    main.innerHTML = html;

    // Bind events
    document.getElementById('btn-add-monitor').addEventListener('click', openAddModal);
    document.getElementById('btn-billing').addEventListener('click', function () {
      navigate('#/billing');
    });
    document.querySelectorAll('.monitor-card').forEach(function (card) {
      card.addEventListener('click', function () {
        navigate('#/monitor/' + card.dataset.id);
      });
    });
  }

  // --------------- Render: Monitor Detail ---------------

  function renderDetail() {
    var main = document.getElementById('app-content');
    var m = state.currentMonitor;

    if (!m) {
      main.innerHTML = '<div class="loading">Loading...</div>';
      return;
    }

    var status = (m.current_status || 'unknown').toLowerCase();
    var responseTime = m.last_response_time_ms != null ? m.last_response_time_ms + 'ms' : '-';
    var html = '';

    html += '<div class="detail-header">';
    html += '  <button class="back-btn" id="btn-back">&larr;</button>';
    html += '  <div class="detail-title">';
    html += '    <h2>' + escapeHtml(m.name) + '</h2>';
    html += '    <div class="monitor-url">' + escapeHtml(m.url) + '</div>';
    html += '  </div>';
    html += '  <span class="status-badge ' + status + '">' + status + '</span>';
    html += '  <button class="btn btn-danger btn-sm" id="btn-delete">Delete</button>';
    html += '</div>';

    html += '<div class="detail-stats">';
    html += '  <div class="stat-card"><div class="stat-label">Status</div><div class="stat-value ' + status + '">' + status.charAt(0).toUpperCase() + status.slice(1) + '</div></div>';
    html += '  <div class="stat-card"><div class="stat-label">Response Time</div><div class="stat-value">' + responseTime + '</div></div>';
    html += '  <div class="stat-card"><div class="stat-label">Method</div><div class="stat-value">' + (m.method || 'GET') + '</div></div>';
    html += '  <div class="stat-card"><div class="stat-label">Interval</div><div class="stat-value">' + (m.interval_seconds || 300) + 's</div></div>';
    html += '</div>';

    html += '<div class="checks-section">';
    html += '  <h3>Recent Checks</h3>';

    if (state.checks.length === 0) {
      html += '  <p class="empty-state">No checks recorded yet.</p>';
    } else {
      html += '  <table class="checks-table">';
      html += '    <thead><tr><th>Time</th><th>Status</th><th>Code</th><th>Response</th></tr></thead>';
      html += '    <tbody>';
      state.checks.forEach(function (c) {
        var cStatus = (c.status || 'unknown').toLowerCase();
        html += '<tr>';
        html += '  <td>' + formatTime(c.checked_at) + '</td>';
        html += '  <td><span class="status-badge ' + cStatus + '">' + cStatus + '</span></td>';
        html += '  <td>' + (c.status_code || '-') + '</td>';
        html += '  <td>' + (c.response_time_ms != null ? c.response_time_ms + 'ms' : '-') + '</td>';
        html += '</tr>';
      });
      html += '    </tbody>';
      html += '  </table>';
    }

    html += '</div>';

    main.innerHTML = html;

    // Bind events
    document.getElementById('btn-back').addEventListener('click', function () {
      navigate('#/');
    });
    document.getElementById('btn-delete').addEventListener('click', function () {
      if (confirm('Delete monitor "' + m.name + '"?')) {
        deleteMonitor(m.id);
      }
    });
  }

  // --------------- Render: Billing ---------------

  function renderBilling() {
    var main = document.getElementById('app-content');
    main.innerHTML = '<div class="loading">Loading billing...</div>';

    api('GET', '/billing/status')
      .then(function (data) {
        var html = '';
        html += '<div class="toolbar">';
        html += '  <h2>Billing</h2>';
        html += '  <button class="btn btn-secondary btn-sm" id="btn-back-billing">&larr; Back</button>';
        html += '</div>';

        html += '<div class="detail-stats">';
        html += '  <div class="stat-card"><div class="stat-label">Current Plan</div><div class="stat-value">' + escapeHtml(data.tier.charAt(0).toUpperCase() + data.tier.slice(1)) + '</div></div>';
        html += '  <div class="stat-card"><div class="stat-label">Monitors Used</div><div class="stat-value">' + data.monitors_used + ' / ' + data.monitors_limit + '</div></div>';
        html += '</div>';

        if (data.tier === 'free') {
          html += '<div style="margin-top:1.5rem;">';
          html += '  <h3 style="margin-bottom:0.75rem;">Upgrade</h3>';
          html += '  <div style="display:flex;gap:1rem;flex-wrap:wrap;">';
          html += '    <div class="stat-card" style="flex:1;min-width:200px;">';
          html += '      <div class="stat-label">Pro</div>';
          html += '      <div class="stat-value">$9/mo</div>';
          html += '      <p style="font-size:0.8125rem;color:var(--color-text-muted);margin:0.5rem 0;">20 monitors, 1-min checks, 90-day history</p>';
          html += '      <button class="btn btn-primary btn-sm" data-plan="pro">Upgrade to Pro</button>';
          html += '    </div>';
          html += '    <div class="stat-card" style="flex:1;min-width:200px;">';
          html += '      <div class="stat-label">Team</div>';
          html += '      <div class="stat-value">$29/mo</div>';
          html += '      <p style="font-size:0.8125rem;color:var(--color-text-muted);margin:0.5rem 0;">50 monitors, 5 status pages, 1-year history</p>';
          html += '      <button class="btn btn-primary btn-sm" data-plan="team">Upgrade to Team</button>';
          html += '    </div>';
          html += '  </div>';
          html += '</div>';
        } else if (data.has_billing) {
          html += '<div style="margin-top:1.5rem;">';
          html += '  <button class="btn btn-secondary" id="btn-manage-billing">Manage Billing</button>';
          html += '</div>';
        }

        main.innerHTML = html;

        document.getElementById('btn-back-billing').addEventListener('click', function () {
          navigate('#/');
        });

        // Upgrade buttons
        main.querySelectorAll('[data-plan]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var plan = btn.dataset.plan;
            btn.disabled = true;
            btn.textContent = 'Redirecting...';
            api('POST', '/billing/checkout', { plan: plan, interval: 'monthly' })
              .then(function (data) {
                window.location.href = data.url;
              })
              .catch(function (err) {
                showToast(err.message, 'error');
                btn.disabled = false;
                btn.textContent = 'Upgrade to ' + plan.charAt(0).toUpperCase() + plan.slice(1);
              });
          });
        });

        // Manage billing button
        var manageBtn = document.getElementById('btn-manage-billing');
        if (manageBtn) {
          manageBtn.addEventListener('click', function () {
            manageBtn.disabled = true;
            manageBtn.textContent = 'Redirecting...';
            api('POST', '/billing/portal')
              .then(function (data) {
                window.location.href = data.url;
              })
              .catch(function (err) {
                showToast(err.message, 'error');
                manageBtn.disabled = false;
                manageBtn.textContent = 'Manage Billing';
              });
          });
        }
      })
      .catch(function (err) {
        showToast('Failed to load billing: ' + err.message, 'error');
        navigate('#/');
      });
  }

  // --------------- Modal ---------------

  function openAddModal() {
    document.getElementById('add-modal').classList.remove('hidden');
    document.getElementById('monitor-name').focus();
  }

  function closeAddModal() {
    document.getElementById('add-modal').classList.add('hidden');
    document.getElementById('add-form').reset();
  }

  function handleAddSubmit(e) {
    e.preventDefault();
    var data = {
      name: document.getElementById('monitor-name').value.trim(),
      url: document.getElementById('monitor-url').value.trim(),
      method: document.getElementById('monitor-method').value,
      expected_status: parseInt(document.getElementById('monitor-expected-status').value, 10) || 200,
      interval_seconds: parseInt(document.getElementById('monitor-interval').value, 10) || 300
    };

    if (!data.name || !data.url) {
      showToast('Name and URL are required.', 'error');
      return;
    }

    var btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Creating...';

    api('POST', '/monitors', data)
      .then(function () {
        closeAddModal();
        showToast('Monitor created.', 'success');
        loadMonitors();
      })
      .catch(function (err) {
        showToast(err.message, 'error');
      })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = 'Create Monitor';
      });
  }

  // --------------- CRUD ---------------

  function loadMonitors() {
    return api('GET', '/monitors')
      .then(function (data) {
        state.monitors = data.monitors || data || [];
        var route = getRoute();
        if (route.view === 'list') {
          renderList();
        }
      })
      .catch(function (err) {
        showToast('Failed to load monitors: ' + err.message, 'error');
      });
  }

  function loadMonitorDetail(id) {
    state.currentMonitor = null;
    state.checks = [];
    renderDetail();

    var pMonitor = api('GET', '/monitors/' + id).then(function (data) {
      state.currentMonitor = data.monitor || data;
    });

    var pChecks = api('GET', '/monitors/' + id + '/checks?limit=50').then(function (data) {
      state.checks = data.checks || data || [];
    });

    Promise.all([pMonitor, pChecks])
      .then(function () {
        renderDetail();
      })
      .catch(function (err) {
        showToast('Failed to load monitor: ' + err.message, 'error');
        navigate('#/');
      });
  }

  function deleteMonitor(id) {
    api('DELETE', '/monitors/' + id)
      .then(function () {
        showToast('Monitor deleted.', 'success');
        navigate('#/');
        loadMonitors();
      })
      .catch(function (err) {
        showToast('Failed to delete: ' + err.message, 'error');
      });
  }

  // --------------- Router Handler ---------------

  function handleRoute() {
    var route = getRoute();
    if (route.view === 'detail') {
      loadMonitorDetail(route.id);
    } else if (route.view === 'billing') {
      renderBilling();
    } else {
      renderList();
    }
  }

  // --------------- Auto-refresh ---------------

  function startAutoRefresh() {
    stopAutoRefresh();
    state.refreshTimer = setInterval(function () {
      var route = getRoute();
      if (route.view === 'list') {
        loadMonitors();
      } else if (route.view === 'detail' && route.id) {
        loadMonitorDetail(route.id);
      }
    }, REFRESH_INTERVAL);
  }

  function stopAutoRefresh() {
    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
  }

  // --------------- Utility ---------------

  function escapeHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --------------- Init ---------------

  function init() {
    state.token = localStorage.getItem('pingbase_token');
    if (!state.token) {
      window.location.href = 'login.html';
      return;
    }

    state.email = localStorage.getItem('pingbase_email') || '';
    state.tier = localStorage.getItem('pingbase_tier') || 'free';

    // Set user display
    document.getElementById('header-user').textContent = state.email;

    // Bind header logout
    document.getElementById('btn-logout').addEventListener('click', logout);

    // Bind modal
    document.getElementById('modal-close').addEventListener('click', closeAddModal);
    document.getElementById('modal-cancel').addEventListener('click', closeAddModal);
    document.getElementById('add-form').addEventListener('submit', handleAddSubmit);
    document.getElementById('add-modal').addEventListener('click', function (e) {
      if (e.target === this) closeAddModal();
    });

    // Route
    window.addEventListener('hashchange', handleRoute);

    // Load and render
    loadMonitors().then(function () {
      handleRoute();
    });

    startAutoRefresh();
  }

  // Go
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
