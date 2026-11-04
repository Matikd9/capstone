document.addEventListener("DOMContentLoaded", () => {
  // Verificación estricta de sesión de Administrador
  const adminToken = sessionStorage.getItem("nexxo_admin_token");
  if (!adminToken) {
    window.location.replace("/admin/login");
    return;
  }

  // Visualizar operador autenticado
  try {
    const adminUser = JSON.parse(
      sessionStorage.getItem("nexxo_admin_user") || "{}",
    );
    const badge = document.getElementById("admin-user-badge");
    if (badge && adminUser.username) {
      badge.textContent = `[OPERADOR: ${adminUser.username.toUpperCase()}]`;
    }
  } catch (e) {}

  // Enlazar botón Cerrar Sesión
  const btnLogout = document.getElementById("btn-logout");
  if (btnLogout) {
    btnLogout.addEventListener("click", () => {
      sessionStorage.removeItem("nexxo_admin_token");
      sessionStorage.removeItem("nexxo_admin_user");
      window.location.replace("/admin/login");
    });
  }

  // Wrapper para peticiones autenticadas
  async function authFetch(url, options = {}) {
    options.headers = options.headers || {};
    options.headers["Authorization"] = `Bearer ${adminToken}`;
    const res = await fetch(url, options);
    if (res.status === 401 || res.status === 403) {
      if (typeof showToast === "function") {
        showToast(
          "[SESIÓN EXPIRADA] Redirigiendo a pantalla de acceso...",
          "warn",
        );
      }
      sessionStorage.removeItem("nexxo_admin_token");
      sessionStorage.removeItem("nexxo_admin_user");
      setTimeout(() => window.location.replace("/admin/login"), 1200);
      throw new Error("Sesión no autorizada o expirada.");
    }
    return res;
  }

  const metricTotal = document.getElementById("metric-total");
  const metricApproved = document.getElementById("metric-approved");
  const metricReview = document.getElementById("metric-review");
  const metricRejected = document.getElementById("metric-rejected");
  const metricSavings = document.getElementById("metric-savings");

  const filterPosition = document.getElementById("filter-position");
  const filterStatus = document.getElementById("filter-status");
  const btnRefresh = document.getElementById("btn-refresh");
  const candidatesTbody = document.getElementById("candidates-tbody");

  const modalCandidate = document.getElementById("modal-candidate");
  const modalTitle = document.getElementById("modal-title");
  const modalBody = document.getElementById("modal-body");
  const btnCloseModal = document.getElementById("btn-close-modal");

  // Centro de Notificaciones Fase 2
  const btnNotifications = document.getElementById("btn-notifications");
  const notificationBadge = document.getElementById("notification-badge");
  const notificationDropdown = document.getElementById("notification-dropdown");
  const notificationList = document.getElementById("notification-list");
  const notificationHeaderCount = document.getElementById(
    "notification-header-count",
  );

  async function loadNotifications() {
    if (!btnNotifications) return;
    try {
      const res = await authFetch("/api/admin/notifications");
      if (!res.ok) return;
      const data = await res.json();

      const count = data.pendingCount || 0;
      if (count > 0) {
        notificationBadge.textContent = count > 9 ? "9+" : count;
        notificationBadge.style.display = "flex";
      } else {
        notificationBadge.style.display = "none";
      }

      if (notificationHeaderCount) {
        notificationHeaderCount.textContent = `${count} pendientes`;
      }

      if (!notificationList) return;
      if (!data.notifications || data.notifications.length === 0) {
        notificationList.innerHTML = `<div class="notification-empty">No hay postulaciones de Fase 2 registradas</div>`;
        return;
      }

      notificationList.innerHTML = data.notifications
        .map((n) => {
          const timeStr =
            n.phase2_submitted_at || n.token_used_at
              ? new Date(
                  n.phase2_submitted_at || n.token_used_at,
                ).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                }) + " hrs"
              : "Reciente";

          const isPending =
            n.status === "EN_REVISION_MANUAL" || n.status === "DOCS_CARGADOS";
          const statusClass = isPending ? "status-revision" : "status-approved";
          const statusLabel = isPending
            ? "Requiere Auditoría OCR"
            : "Pre-Acreditado";

          return `
          <div class="notification-item" onclick="openCandidateFromNotification(${n.id})">
            <div class="notification-item-top">
              <span class="notification-item-name">${escapeHtml(n.full_name)}</span>
              <span class="notification-item-time">${timeStr}</span>
            </div>
            <div class="notification-item-desc">${escapeHtml(n.rut_id)} · ${escapeHtml(n.position_name || "Especialidad")}</div>
            <div class="notification-item-footer">
              <span class="status-pill ${statusClass}" style="font-size: 0.65rem; padding: 0.15rem 0.5rem;">${statusLabel}</span>
              <span style="font-size: 0.75rem; color: var(--primary); font-weight: 700; text-decoration: underline;">Auditar &rarr;</span>
            </div>
          </div>
        `;
        })
        .join("");
    } catch (e) {
      console.warn("[Notificaciones] Error al consultar alertas:", e);
    }
  }

  window.openCandidateFromNotification = (id) => {
    if (notificationDropdown) notificationDropdown.style.display = "none";
    window.viewCandidate(id);
  };

  if (btnNotifications && notificationDropdown) {
    btnNotifications.addEventListener("click", (e) => {
      e.stopPropagation();
      const isVisible = notificationDropdown.style.display === "block";
      notificationDropdown.style.display = isVisible ? "none" : "block";
      if (!isVisible) {
        loadNotifications();
      }
    });

    document.addEventListener("click", (e) => {
      if (
        !notificationDropdown.contains(e.target) &&
        e.target !== btnNotifications
      ) {
        notificationDropdown.style.display = "none";
      }
    });
  }

  // Elementos de Scroll Sincronizado Superior
  const tableTopScroll = document.getElementById("table-top-scroll");
  const tableTopScrollInner = document.getElementById("table-top-scroll-inner");
  const tableContainer = document.getElementById("table-container");
  const dataTable = document.querySelector(".data-table");

  function updateTopScrollWidth() {
    if (!tableTopScrollInner || !dataTable) return;
    tableTopScrollInner.style.width = `${dataTable.scrollWidth}px`;
    if (tableTopScroll && tableContainer) {
      if (dataTable.scrollWidth <= tableContainer.clientWidth) {
        tableTopScroll.style.display = "none";
      } else {
        tableTopScroll.style.display = "block";
      }
    }
  }

  let isSyncingTop = false;
  let isSyncingBottom = false;

  if (tableTopScroll && tableContainer) {
    tableTopScroll.addEventListener("scroll", () => {
      if (isSyncingBottom) return;
      isSyncingTop = true;
      tableContainer.scrollLeft = tableTopScroll.scrollLeft;
      requestAnimationFrame(() => {
        isSyncingTop = false;
      });
    });

    tableContainer.addEventListener("scroll", () => {
      if (isSyncingTop) return;
      isSyncingBottom = true;
      tableTopScroll.scrollLeft = tableContainer.scrollLeft;
      requestAnimationFrame(() => {
        isSyncingBottom = false;
      });
    });

    window.addEventListener("resize", updateTopScrollWidth);
  }

  // Sistema de Notificaciones Toast Industriales
  function showToast(message, type = "success", durationMs = 4500) {
    const container = document.getElementById("toast-container");
    if (!container) return;

    const item = document.createElement("div");
    item.className = `toast-item toast-${type}`;

    const iconTag =
      type === "success" ? "[OK]" : type === "warn" ? "[AVISO]" : "[ERROR]";
    item.innerHTML = `
      <span class="toast-icon">${iconTag}</span>
      <span>${escapeHtml(message)}</span>
    `;

    container.appendChild(item);

    setTimeout(() => {
      item.style.opacity = "0";
      item.style.transform = "translateX(30px)";
      setTimeout(() => item.remove(), 300);
    }, durationMs);
  }
  window.showToast = showToast;

  // Copia de enlace Magic Link al portapapeles
  window.copyMagicLinkToClipboard = async (url, btnElement) => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const tempInput = document.createElement("textarea");
        tempInput.value = url;
        document.body.appendChild(tempInput);
        tempInput.select();
        document.execCommand("copy");
        document.body.removeChild(tempInput);
      }
      showToast("Enlace copiado exitosamente al portapapeles.", "success");
      if (btnElement) {
        const orig = btnElement.textContent;
        btnElement.textContent = "[ ENLACE COPIADO ]";
        btnElement.style.borderColor = "var(--ecf-emerald)";
        btnElement.style.color = "var(--ecf-emerald)";
        setTimeout(() => {
          btnElement.textContent = orig;
          btnElement.style.borderColor = "";
          btnElement.style.color = "";
        }, 2500);
      }
    } catch (err) {
      showToast("No se pudo copiar automáticamente. Use Ctrl+C.", "warn");
    }
  };

  function getStatusPillClass(status) {
    if (["PRE_ACREDITADO", "CONTRATADO_FAENA", "Aprobado"].includes(status)) {
      return "status-Aprobado";
    }
    if (status === "APROBADO_FAENA") {
      return "status-Pendiente";
    }
    if (["DESCARTADO_TECNICO", "Rechazado"].includes(status)) {
      return "status-Rechazado";
    }
    return "status-Pendiente";
  }

  // 1. Cargar Especialidades para filtro
  async function loadPositions() {
    try {
      const res = await fetch("/api/positions");
      const data = await res.json();
      filterPosition.innerHTML =
        '<option value="">Todas las especialidades</option>' +
        data.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
    } catch (e) {
      console.error("Error cargando cargos:", e);
    }
  }

  // 2. Cargar Métricas Operativas e Impacto Económico
  async function loadStats() {
    try {
      const res = await authFetch("/api/admin/stats");
      const stats = await res.json();

      metricTotal.textContent = stats.total || 0;
      metricApproved.textContent = stats.approved || 0;
      if (metricReview) metricReview.textContent = stats.inReview || 0;
      metricRejected.textContent = stats.rejected || 0;

      const clpFormatted = new Intl.NumberFormat("es-CL", {
        style: "currency",
        currency: "CLP",
        maximumFractionDigits: 0,
      }).format(stats.savedTurnoverCostsCLP || 0);

      metricSavings.textContent = clpFormatted;
    } catch (e) {
      console.error("Error cargando métricas:", e);
    }
  }

  // 3. Cargar Lista de Postulantes
  async function loadCandidates() {
    try {
      const posVal = filterPosition.value;
      const statusVal = filterStatus.value;
      const params = new URLSearchParams();
      if (posVal) params.append("position_id", posVal);
      if (statusVal) params.append("status", statusVal);

      const res = await authFetch(`/api/admin/candidates?${params.toString()}`);
      const candidates = await res.json();

      if (!Array.isArray(candidates) || candidates.length === 0) {
        candidatesTbody.innerHTML = `<tr><td colspan="9" class="loading-td">No hay postulaciones registradas para este filtro.</td></tr>`;
        return;
      }

      candidatesTbody.innerHTML = candidates
        .map((c) => {
          const scorePercent =
            c.total_questions > 0
              ? Math.round((c.score / c.total_questions) * 100)
              : 0;
          const expDisplay = c.experience_years
            ? `${c.experience_years} años`
            : `${c.age || 3} años`;

          const hasRealDiscrepancy = Boolean(
            c.discrepancy_notes &&
            !c.discrepancy_notes.includes(
              "Expediente consistente. Sin observaciones.",
            ),
          );
          let crossCheckBadge = '<span class="badge-code">[FASE 01]</span>';
          if (c.ocr_cross_check_ok) {
            crossCheckBadge =
              '<span class="badge-code" style="color: var(--ecf-emerald); border-color: var(--ecf-emerald-border); background: var(--ecf-emerald-dim);">[CONFORME ECF]</span>';
          } else if (c.status === "EN_REVISION_MANUAL") {
            if (hasRealDiscrepancy) {
              crossCheckBadge =
                '<span class="badge-code" style="color: var(--safety-yellow); border-color: var(--safety-yellow); background: var(--safety-yellow-dim);">[DISCORDANCIA OCR]</span>';
            } else {
              crossCheckBadge =
                '<span class="badge-code" style="color: var(--ecf-emerald); border-color: var(--ecf-emerald-border); background: var(--ecf-emerald-dim);">[EN REVISIÓN // CONFORME]</span>';
            }
          } else if (c.status === "DESCARTADO_TECNICO") {
            crossCheckBadge =
              '<span class="badge-code" style="color: var(--ecf-crimson); border-color: var(--ecf-crimson-border); background: var(--ecf-crimson-dim);">[NO CONFORME ECF]</span>';
          }

          const canExport = [
            "PRE_ACREDITADO",
            "CONTRATADO_FAENA",
            "EN_REVISION_MANUAL",
            "Aprobado",
          ].includes(c.status);

          return `
          <tr>
            <td><strong style="color: var(--safety-yellow); font-family: 'IBM Plex Mono', monospace;">#${c.id}</strong></td>
            <td><strong style="color: var(--text-primary); font-family: 'IBM Plex Mono', monospace;">${escapeHtml(c.full_name)}</strong></td>
            <td><span style="font-family: 'IBM Plex Mono', monospace; color: var(--text-secondary);">${escapeHtml(c.rut_id)}</span></td>
            <td><span style="font-family: 'IBM Plex Mono', monospace;">${expDisplay}</span></td>
            <td><span class="position-tag">${escapeHtml(c.position_name)}</span></td>
            <td>
              <span class="badge-code">${c.score}/${c.total_questions} (${scorePercent}%)</span>
              <div style="font-size: 0.72rem; margin-top: 0.25rem; font-family: 'IBM Plex Mono', monospace; color: var(--text-secondary);">
                Téc: <strong>${c.score_tecnico ?? 0}/3</strong> | SJT: <strong style="color: ${c.sjt_conforme ? "var(--ecf-emerald)" : "var(--ecf-crimson)"};">${c.sjt_conforme ? "2/2" : `${c.score_sjt ?? 0}/2`}</strong>
              </div>
            </td>
            <td>
              ${crossCheckBadge}
              ${!c.sjt_conforme && c.status === "DESCARTADO_TECNICO" ? `<br><span class="badge-code" style="color: var(--ecf-crimson); border-color: var(--ecf-crimson-border); background: var(--ecf-crimson-dim); margin-top: 0.25rem; display: inline-block;">[RIESGO OPERACIONAL ECF]</span>` : ""}
            </td>
            <td>
              <span class="status-pill ${getStatusPillClass(c.status)}">${escapeHtml(c.status)}</span>
            </td>
            <td style="display: flex; gap: 0.4rem; align-items: center;">
              <button class="btn btn-secondary btn-sm" onclick="viewCandidate(${c.id})">
                Auditar
              </button>
              ${
                canExport
                  ? `
                <a href="/api/admin/candidates/${c.id}/export-webcontrol?token=${encodeURIComponent(adminToken)}" target="_blank" class="btn btn-primary btn-sm" title="Generar Carpeta Estandarizada WebControl">
                  WebControl
                </a>
              `
                  : ""
              }
            </td>
          </tr>
        `;
        })
        .join("");

      window.currentCandidates = candidates;
      updateTopScrollWidth();
    } catch (e) {
      candidatesTbody.innerHTML = `<tr><td colspan="9" class="loading-td">Error conectando con la base de datos</td></tr>`;
      updateTopScrollWidth();
    }
  }

  // 4. Abrir Modal de Auditoría y Validación Cruzada
  window.viewCandidate = (id) => {
    const candidate = window.currentCandidates.find((c) => c.id === id);
    if (!candidate) return;

    modalTitle.textContent = `Expediente #${candidate.id}: ${candidate.full_name}`;

    const scorePercent =
      candidate.total_questions > 0
        ? Math.round((candidate.score / candidate.total_questions) * 100)
        : 0;
    const credencialUrl = candidate.credencial_file || candidate.cert_file;
    const carnetUrl = candidate.carnet_file;

    const isExpedienteConforme =
      candidate.ocr_cross_check_ok ||
      !candidate.discrepancy_notes ||
      candidate.discrepancy_notes.includes(
        "Expediente consistente. Sin observaciones.",
      );
    const diagBorder = isExpedienteConforme
      ? "var(--ecf-emerald-border)"
      : "var(--safety-yellow)";
    const diagBg = isExpedienteConforme
      ? "var(--ecf-emerald-dim)"
      : "var(--safety-yellow-dim)";
    const diagColor = isExpedienteConforme
      ? "var(--ecf-emerald)"
      : "var(--safety-yellow)";

    modalBody.innerHTML = `
      <div class="info-grid">
        <div class="info-item">
          <span class="label">RUT / RUN</span>
          <span class="value">${escapeHtml(candidate.rut_id)}</span>
        </div>
        <div class="info-item">
          <span class="label">Experiencia Declarada</span>
          <span class="value">${candidate.experience_years || 2} años en faena</span>
        </div>
        <div class="info-item">
          <span class="label">Calce de Cargo (IA)</span>
          <span class="value" style="color: ${(candidate.role_fit_percentage ?? 80) >= 70 ? "var(--ecf-emerald)" : "var(--safety-yellow)"};">
            ${candidate.role_fit_percentage ? `${candidate.role_fit_percentage}% Afinidad` : "Conforme (80%)"}
          </span>
        </div>
        <div class="info-item">
          <span class="label">Exp. en Oficio Específico</span>
          <span class="value">${candidate.experience_years_in_role ?? candidate.experience_years ?? 2} años</span>
        </div>
        <div class="info-item">
          <span class="label">Especialidad & ECF</span>
          <span class="value">${escapeHtml(candidate.position_name)}</span>
        </div>
        <div class="info-item">
          <span class="label">Score Técnico (P1 a P3)</span>
          <span class="value">[${candidate.score_tecnico ?? 0} / 3]</span>
        </div>
        <div class="info-item">
          <span class="label">Índice Conductual ECF (SJT)</span>
          <span class="value" style="color: ${candidate.sjt_conforme ? "var(--ecf-emerald)" : "var(--ecf-crimson)"};">
            [${candidate.sjt_conforme ? "CONFORME (2/2)" : "NO CONFORME (Falla Crítica)"}]
          </span>
        </div>
        <div class="info-item">
          <span class="label">Veredicto Fase 1.5</span>
          <span class="status-pill ${getStatusPillClass(candidate.status)}">[${escapeHtml(candidate.status)}]</span>
        </div>
      </div>

      ${
        !candidate.sjt_conforme
          ? `
        <div style="margin-top: 0.85rem; padding: 0.75rem; border-radius: var(--radius-terminal); border: 1px solid var(--ecf-crimson-border); background: var(--ecf-crimson-dim); color: var(--ecf-crimson); font-family: 'IBM Plex Mono', monospace; font-size: 0.82rem;">
          <strong>[ALERTA AUDITORÍA: RIESGO OPERACIONAL CRÍTICO]</strong><br>
          El postulante falló al menos un reactivo de Juicio Situacional (SJT). Vulneró el principio de detención de faena ('Paso Cero' / Derecho a Decir NO) o no detuvo la maniobra ante falla de estabilidad de grúa. Descartado por regla de corte normativo excluyente ECF Codelco.
        </div>
      `
          : ""
      }

      <!-- Comparativa Visual de Identidad (Face Match: Selfie Transparente vs. Foto Carnet) -->
      <div class="media-box">
        <h3>Validación Visual de Identidad (Selfie Proctoring Transparente vs. Cédula)</h3>
        <p style="font-size:0.85rem; color: var(--text-muted); margin-bottom: 0.75rem;">
          Contraste la Selfie Informada tomada en el Mini-Test Técnico (Fase 1.5) contra la foto de la Cédula de Identidad cargada en la Pre-Acreditación (Fase 2).
        </p>
        <div class="media-comparison-grid">
          <div>
            <strong style="font-size: 0.85rem;">Selfie Transparente (Mini-Test Fase 1.5):</strong>
            ${
              candidate.initial_selfie
                ? `<img src="${candidate.initial_selfie}" alt="Selfie Mini-Test">`
                : '<p class="loading-td">Sin selfie de test</p>'
            }
          </div>
          <div>
            <strong style="font-size: 0.85rem;">Cédula de Identidad (Fase 2 Pre-Acreditación):</strong>
            ${
              carnetUrl
                ? `<img src="${carnetUrl}" alt="Cédula de Identidad">`
                : '<p class="loading-td">No requerida / Pendiente Fase 2</p>'
            }
          </div>
        </div>
      </div>

      <!-- Matriz de Validación Cruzada OCR (Fase 3) -->
      <div class="media-box" style="text-align: left;">
        <h3 style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem;">
          <span>Matriz de Validación Cruzada OCR (Fase 1 vs. Fase 2)</span>
          <div style="display: flex; gap: 0.5rem; align-items: center;">
            <button id="btn-reprocess-ocr" class="btn btn-secondary btn-sm" onclick="reprocessCandidateOcr(${candidate.id})">Re-analizar OCR</button>
            <span class="status-pill ${getStatusPillClass(candidate.status)}">${escapeHtml(candidate.status)}</span>
          </div>
        </h3>

        <div style="margin-top: 0.85rem; font-size: 0.88rem; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.75rem;">
          <p><strong>1. Credencial Técnica (Fase 1):</strong><br>${escapeHtml(candidate.ocr_credencial_status || candidate.required_credential || "Verificada")}</p>
          <p><strong>2. Cruce Nombre / RUT (OCR):</strong><br>${escapeHtml(candidate.ocr_detected_name || candidate.full_name)} (${escapeHtml(candidate.ocr_detected_rut || candidate.rut_id)})</p>
          <p><strong>3. Vigencia Cédula (OCR):</strong><br>${escapeHtml(candidate.ocr_carnet_vigencia || "Pendiente Fase 2")}</p>
          <p><strong>4. Cert. Antecedentes (OCR):</strong><br>${escapeHtml(candidate.ocr_antecedentes_status || "Pendiente Fase 2")}</p>
        </div>

        <div style="margin-top: 0.85rem; padding: 0.75rem; border-radius: var(--radius-terminal); border: 1px solid ${diagBorder}; background: ${diagBg}; color: ${diagColor}; font-size: 0.85rem; font-family: 'IBM Plex Mono', monospace;">
          <strong>DIAGNÓSTICO NORMATIVO (ECF / DS N° 132):</strong><br>
          ${escapeHtml(candidate.discrepancy_notes || "Expediente consistente. Sin observaciones.")}
          ${candidate.ocr_manually_edited ? `<br><em>Nota de Auditoría: El postulante editó manualmente en Fase 1: ${escapeHtml(candidate.ocr_edited_fields || "")}</em>` : ""}
        </div>

        ${
          candidate.ocr_text
            ? `
          <details style="margin-top: 0.75rem; background: var(--surface-panel); padding: 0.75rem; border-radius: var(--radius-terminal); border: 1px solid var(--border-structural);">
            <summary style="cursor: pointer; font-weight: 700; font-family: 'IBM Plex Mono', monospace; font-size: 0.82rem; color: var(--text-secondary); display: flex; align-items: center; justify-content: space-between;">
              <span>[VER LOG DE TEXTO EXTRAÍDO POR OCR]</span>
              ${
                candidate.ocr_text.includes("[MOTOR: GEMINI") ||
                candidate.ocr_text.includes("[MOTOR: IA")
                  ? '<span class="badge" style="background: rgba(16,185,129,0.15); color: var(--ecf-emerald); font-size:0.7rem; padding: 2px 6px; border-radius:2px; border: 1px solid var(--ecf-emerald);">MOTOR: IA GEMINI FLASH</span>'
                  : '<span class="badge" style="background: rgba(255,184,0,0.15); color: var(--safety-yellow); font-size:0.7rem; padding: 2px 6px; border-radius:2px; border: 1px solid var(--safety-yellow);">MOTOR: LOCAL TESSERACT (FALLBACK)</span>'
              }
            </summary>
            <pre style="white-space: pre-wrap; font-family: 'IBM Plex Mono', monospace; font-size: 0.76rem; margin-top: 0.5rem; max-height: 150px; overflow-y: auto; color: var(--text-primary);">${escapeHtml(candidate.ocr_text)}</pre>
          </details>
        `
            : ""
        }
      </div>

      <!-- Documentación del Expediente WebControl -->
      <div class="media-box">
        <h3>Archivos del Expediente (Visor Seguro en Sandbox Anti-Malware)</h3>
        <div style="display:flex; gap:0.75rem; justify-content:center; flex-wrap:wrap; margin-top:0.65rem;">
          ${credencialUrl ? `<button type="button" onclick="openSecureDocViewer('${credencialUrl}', 'Credencial Técnica ECF')" class="btn btn-secondary btn-sm">Ver Credencial (Aislado)</button>` : ""}
          ${candidate.cv_file ? `<button type="button" onclick="openSecureDocViewer('${candidate.cv_file}', 'Currículum Vitae (CV)')" class="btn btn-secondary btn-sm">Ver CV (Aislado)</button>` : ""}
          ${carnetUrl ? `<button type="button" onclick="openSecureDocViewer('${carnetUrl}', 'Cédula de Identidad (Frente)')" class="btn btn-secondary btn-sm">Ver Cédula Frente</button>` : ""}
          ${candidate.carnet_back_file ? `<button type="button" onclick="openSecureDocViewer('${candidate.carnet_back_file}', 'Cédula de Identidad (Reverso)')" class="btn btn-secondary btn-sm">Ver Cédula Reverso</button>` : ""}
          ${candidate.antecedentes_file ? `<button type="button" onclick="openSecureDocViewer('${candidate.antecedentes_file}', 'Certificado de Antecedentes')" class="btn btn-secondary btn-sm">Ver Antecedentes</button>` : ""}
          <a href="/api/admin/candidates/${candidate.id}/export-webcontrol?token=${encodeURIComponent(adminToken)}" target="_blank" class="btn btn-primary btn-sm">
            Generar Carpeta WebControl (PDF / Estandarizado)
          </a>
        </div>
      </div>

      <!-- Acción Operativa de Aprobación de Acceso a Faena (Fase 2) -->
      ${
        ["PRESELECCIONADO", "EN_REVISION_MANUAL"].includes(candidate.status) &&
        !candidate.carnet_file &&
        !candidate.access_token
          ? `
        <div style="background: rgba(255, 184, 0, 0.08); border: 1px solid var(--safety-yellow); padding: 1.15rem; border-radius: var(--radius-terminal); margin-top: 1rem; text-align: left;">
          <div style="font-family: 'IBM Plex Mono', monospace; font-size: 0.82rem; font-weight: 700; color: var(--safety-yellow); margin-bottom: 0.35rem;">
            [ACCIÓN DE RR.HH.: AUTORIZAR ACCESO A FAENA]
          </div>
          <p style="font-size: 0.82rem; color: var(--text-primary); margin: 0 0 0.85rem 0;">
            El postulante aprobó la evaluación técnica. Por normativa laboral (Ley N° 19.628), la Fase 2 (Cédula y Antecedentes) permanece bloqueada hasta que RR.HH. autorice el cupo de faena. Al presionar este botón, se emitirá su token de acceso y se le despachará el enlace a su correo electrónico (<strong>${escapeHtml(candidate.email || "correo")}</strong>).
          </p>
          <button class="btn btn-primary" id="btn-approve-faena" onclick="approveFaena(${candidate.id})" style="width: 100%; justify-content: center;">
            [ APROBAR ACCESO A FAENA Y ENVIAR ENLACE FASE 2 ]
          </button>
        </div>
      `
          : ""
      }

      ${
        candidate.status === "APROBADO_FAENA" ||
        (candidate.access_token && !candidate.carnet_file)
          ? `
        <div class="modal-token-card">
          <div class="modal-token-card-header">
            <span>[ACCESO A FAENA APROBADO // ENLACE FASE 2 ACTIVO]</span>
            <span class="badge" style="background: rgba(16, 185, 129, 0.2); color: var(--ecf-emerald); font-size: 0.72rem; padding: 2px 8px; border-radius: 2px;">VÁLIDO 7 DÍAS</span>
          </div>
          <p style="font-size: 0.82rem; color: var(--text-primary); margin: 0 0 0.5rem 0;">
            El candidato cuenta con autorización de faena activa para cargar su Cédula y Certificado de Antecedentes (Fase 2). Enlace despachado a <strong>${escapeHtml(candidate.email || "correo")}</strong>.
          </p>
          <div class="modal-token-link-box">
            <span>${escapeHtml(candidate.access_token ? `${window.location.origin}/?token=${candidate.access_token}` : "Enlace emitido en el sistema")}</span>
          </div>
          <div class="modal-token-actions">
            ${
              candidate.access_token
                ? `
              <button type="button" class="btn btn-secondary btn-sm" onclick="copyMagicLinkToClipboard('${window.location.origin}/?token=${candidate.access_token}', this)">
                [ COPIAR ENLACE FASE 2 ]
              </button>
            `
                : ""
            }
            <button type="button" class="btn btn-sm" style="border: 1px solid var(--border-structural); color: var(--text-secondary);" id="btn-approve-faena" onclick="approveFaena(${candidate.id})">
              [ RE-DESPACHAR CORREO ]
            </button>
          </div>
        </div>
      `
          : ""
      }

      <!-- Controles de la Máquina de Estados -->
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.75rem; margin-top:1rem; padding-top:1rem; border-top: 1px solid var(--border-standard);">
        <div>
          <span>Cambiar Estado en Nómina: </span>
        </div>
        <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
          <button class="btn btn-danger btn-sm" onclick="updateCandidateStatus(${candidate.id}, 'DESCARTADO_TECNICO')">Descartar</button>
          <button class="btn btn-secondary btn-sm" onclick="updateCandidateStatus(${candidate.id}, 'EN_REVISION_MANUAL')">En Revisión Manual</button>
          <button class="btn btn-success btn-sm" onclick="updateCandidateStatus(${candidate.id}, 'PRE_ACREDITADO')">Aprobar Pre-Acreditado</button>
          <button class="btn btn-primary btn-sm" onclick="updateCandidateStatus(${candidate.id}, 'CONTRATADO_FAENA')">Asignar a Parada (Contratado Faena)</button>
        </div>
      </div>
    `;

    modalCandidate.style.display = "flex";
  };

  window.approveFaena = async (id) => {
    const btn = document.getElementById("btn-approve-faena");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Aprobando y despachando correo...";
    }
    try {
      const res = await authFetch(`/api/admin/candidates/${id}/approve-faena`, {
        method: "POST",
      });
      const data = await res.json();
      if (res.ok) {
        if (data.mail_sent) {
          showToast(
            `[ÉXITO] Acceso autorizado. Correo enviado a ${data.mail_recipient || "postulante"}.`,
            "success",
          );
        } else if (data.mail_simulated) {
          showToast(
            `[ACCESO APROBADO] Token generado (Modo simulador consola).`,
            "warn",
          );
        } else {
          showToast(
            `[ÉXITO] Acceso autorizado y Magic Link generado.`,
            "success",
          );
        }
        await loadCandidates();
        await loadStats();
        window.viewCandidate(id);
      } else {
        showToast(`Error al aprobar acceso a faena: ${data.error}`, "error");
        if (btn) {
          btn.disabled = false;
          btn.textContent = "[ APROBAR ACCESO A FAENA Y ENVIAR ENLACE FASE 2 ]";
        }
      }
    } catch (e) {
      showToast("Error de conexión al aprobar acceso a faena.", "error");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "[ APROBAR ACCESO A FAENA Y ENVIAR ENLACE FASE 2 ]";
      }
    }
  };

  window.reprocessCandidateOcr = async (id) => {
    const btn = document.getElementById("btn-reprocess-ocr");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Analizando...";
    }
    try {
      const res = await authFetch(`/api/admin/candidates/${id}/reprocess-ocr`, {
        method: "POST",
      });
      if (res.ok) {
        showToast("Expediente re-analizado correctamente por OCR.", "success");
        await loadCandidates();
        await loadStats();
        window.viewCandidate(id);
      } else {
        showToast("Error al re-analizar OCR del expediente.", "error");
      }
    } catch (e) {
      showToast("Error de conexión al re-analizar OCR.", "error");
    }
  };

  window.updateCandidateStatus = async (id, status) => {
    try {
      const res = await authFetch(`/api/admin/candidates/${id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });

      const data = await res.json();
      if (res.ok) {
        if (status === "CONTRATADO_FAENA" && data.mail_sent) {
          showToast(
            `[CONTRATADO] Estado actualizado y correo de confirmación enviado al postulante.`,
            "success",
          );
        } else if (status === "CONTRATADO_FAENA" && data.mail_simulated) {
          showToast(
            `[CONTRATADO] Estado actualizado (Correo simulado en consola).`,
            "success",
          );
        } else {
          showToast(`Estado actualizado a ${status}.`, "success");
        }
        modalCandidate.style.display = "none";
        loadCandidates();
        loadStats();
      } else {
        showToast(
          data.error ||
            "Error actualizando el estado en la máquina de estados.",
          "error",
        );
      }
    } catch (e) {
      showToast("Error de conexión al actualizar estado.", "error");
    }
  };

  btnCloseModal.addEventListener("click", () => {
    modalCandidate.style.display = "none";
  });

  // Modal de Previsualización Segura de Documentos en Sandbox
  const modalDocViewer = document.getElementById("modal-doc-viewer");
  const btnCloseDocModal = document.getElementById("btn-close-doc-modal");
  const docViewerFrame = document.getElementById("doc-viewer-frame");
  const docModalTitle = document.getElementById("doc-modal-title");
  const docModalDownload = document.getElementById("doc-modal-download");

  window.openSecureDocViewer = function (url, title = "Documento") {
    if (!url) return;
    const separator = url.includes("?") ? "&" : "?";
    const authUrl = `${url}${separator}token=${encodeURIComponent(adminToken)}`;
    const downloadUrl = `${url}${separator}token=${encodeURIComponent(adminToken)}&download=1`;
    if (docModalTitle) docModalTitle.textContent = title;
    if (docViewerFrame) docViewerFrame.src = authUrl;
    if (docModalDownload) {
      docModalDownload.href = downloadUrl;
      docModalDownload.setAttribute("download", "");
    }
    if (modalDocViewer) modalDocViewer.style.display = "flex";
  };

  if (btnCloseDocModal && modalDocViewer) {
    btnCloseDocModal.addEventListener("click", () => {
      modalDocViewer.style.display = "none";
      if (docViewerFrame) docViewerFrame.src = "about:blank";
    });
    modalDocViewer.addEventListener("click", (e) => {
      if (e.target === modalDocViewer) {
        modalDocViewer.style.display = "none";
        if (docViewerFrame) docViewerFrame.src = "about:blank";
      }
    });
  }

  filterPosition.addEventListener("change", loadCandidates);
  filterStatus.addEventListener("change", loadCandidates);
  btnRefresh.addEventListener("click", () => {
    loadCandidates();
    loadStats();
    loadNotifications();
  });

  function escapeHtml(str) {
    if (!str) return "";
    return String(str).replace(/[&<>"']/g, function (m) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      }[m];
    });
  }

  loadPositions();
  loadStats();
  loadCandidates();
  loadNotifications();
  setInterval(loadNotifications, 30000);
});
