document.addEventListener('DOMContentLoaded', () => {
  const metricTotal = document.getElementById('metric-total');
  const metricApproved = document.getElementById('metric-approved');
  const metricReview = document.getElementById('metric-review');
  const metricRejected = document.getElementById('metric-rejected');
  const metricSavings = document.getElementById('metric-savings');

  const filterPosition = document.getElementById('filter-position');
  const filterStatus = document.getElementById('filter-status');
  const btnRefresh = document.getElementById('btn-refresh');
  const candidatesTbody = document.getElementById('candidates-tbody');

  const modalCandidate = document.getElementById('modal-candidate');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');
  const btnCloseModal = document.getElementById('btn-close-modal');

  function getStatusPillClass(status) {
    if (['PRE_ACREDITADO', 'CONTRATADO_FAENA', 'Aprobado'].includes(status)) {
      return 'status-Aprobado';
    }
    if (['DESCARTADO_TECNICO', 'Rechazado'].includes(status)) {
      return 'status-Rechazado';
    }
    return 'status-Pendiente';
  }

  // 1. Cargar Especialidades para filtro
  async function loadPositions() {
    try {
      const res = await fetch('/api/positions');
      const data = await res.json();
      filterPosition.innerHTML = '<option value="">Todas las especialidades</option>' +
        data.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    } catch (e) {
      console.error('Error cargando cargos:', e);
    }
  }

  // 2. Cargar Métricas Operativas e Impacto Económico
  async function loadStats() {
    try {
      const res = await fetch('/api/admin/stats');
      const stats = await res.json();

      metricTotal.textContent = stats.total || 0;
      metricApproved.textContent = stats.approved || 0;
      if (metricReview) metricReview.textContent = stats.inReview || 0;
      metricRejected.textContent = stats.rejected || 0;

      const clpFormatted = new Intl.NumberFormat('es-CL', {
        style: 'currency',
        currency: 'CLP',
        maximumFractionDigits: 0
      }).format(stats.savedTurnoverCostsCLP || 0);

      metricSavings.textContent = clpFormatted;
    } catch (e) {
      console.error('Error cargando métricas:', e);
    }
  }

  // 3. Cargar Lista de Postulantes
  async function loadCandidates() {
    try {
      const posVal = filterPosition.value;
      const statusVal = filterStatus.value;
      const params = new URLSearchParams();
      if (posVal) params.append('position_id', posVal);
      if (statusVal) params.append('status', statusVal);

      const res = await fetch(`/api/admin/candidates?${params.toString()}`);
      const candidates = await res.json();

      if (!Array.isArray(candidates) || candidates.length === 0) {
        candidatesTbody.innerHTML = `<tr><td colspan="9" class="loading-td">No hay postulaciones registradas para este filtro.</td></tr>`;
        return;
      }

      candidatesTbody.innerHTML = candidates.map(c => {
        const scorePercent = c.total_questions > 0 ? Math.round((c.score / c.total_questions) * 100) : 0;
        const expDisplay = c.experience_years ? `${c.experience_years} años` : `${c.age || 3} años`;

        let crossCheckBadge = '<span class="badge-code">Fase 1</span>';
        if (c.ocr_cross_check_ok) {
          crossCheckBadge = '<span class="badge-code" style="background: var(--status-normal-bg); color: var(--status-normal-text); border-color: var(--status-normal-border);">Consistencia 100%</span>';
        } else if (c.status === 'EN_REVISION_MANUAL') {
          crossCheckBadge = '<span class="badge-code" style="background: var(--status-warning-bg); color: var(--status-warning-text); border-color: var(--status-warning-border);">Discordancia OCR</span>';
        } else if (c.status === 'DESCARTADO_TECNICO') {
          crossCheckBadge = '<span class="badge-code" style="background: var(--status-error-bg); color: var(--status-error-text); border-color: var(--status-error-border);">Filtro ECF</span>';
        }

        const canExport = ['PRE_ACREDITADO', 'CONTRATADO_FAENA', 'EN_REVISION_MANUAL', 'Aprobado'].includes(c.status);

        return `
          <tr>
            <td><strong style="color: var(--primary);">#${c.id}</strong></td>
            <td><strong style="color: var(--primary);">${escapeHtml(c.full_name)}</strong></td>
            <td><span style="font-family: monospace; color: var(--text-muted);">${escapeHtml(c.rut_id)}</span></td>
            <td>${expDisplay}</td>
            <td><span class="position-tag">${escapeHtml(c.position_name)}</span></td>
            <td>
              <span class="badge-code">${c.score}/${c.total_questions} (${scorePercent}%)</span>
            </td>
            <td>${crossCheckBadge}</td>
            <td>
              <span class="status-pill ${getStatusPillClass(c.status)}">${escapeHtml(c.status)}</span>
            </td>
            <td style="display: flex; gap: 0.4rem; align-items: center;">
              <button class="btn btn-secondary btn-sm" onclick="viewCandidate(${c.id})">
                Auditar
              </button>
              ${canExport ? `
                <a href="/api/admin/candidates/${c.id}/export-webcontrol" target="_blank" class="btn btn-primary btn-sm" title="Generar Carpeta Estandarizada WebControl">
                  WebControl
                </a>
              ` : ''}
            </td>
          </tr>
        `;
      }).join('');

      window.currentCandidates = candidates;
    } catch (e) {
      candidatesTbody.innerHTML = `<tr><td colspan="9" class="loading-td">Error conectando con la base de datos</td></tr>`;
    }
  }

  // 4. Abrir Modal de Auditoría y Validación Cruzada
  window.viewCandidate = (id) => {
    const candidate = window.currentCandidates.find(c => c.id === id);
    if (!candidate) return;

    modalTitle.textContent = `Expediente #${candidate.id}: ${candidate.full_name}`;

    const scorePercent = candidate.total_questions > 0 ? Math.round((candidate.score / candidate.total_questions) * 100) : 0;
    const credencialUrl = candidate.credencial_file || candidate.cert_file;
    const carnetUrl = candidate.carnet_file;

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
          <span class="label">Especialidad & ECF</span>
          <span class="value">${escapeHtml(candidate.position_name)}</span>
        </div>
        <div class="info-item">
          <span class="label">Mini-Test Técnico (&ge;80%)</span>
          <span class="value">${candidate.score} / ${candidate.total_questions} (${scorePercent}%)</span>
        </div>
      </div>

      <!-- Comparativa Visual de Identidad (Face Match: Selfie Transparente vs. Foto Carnet) -->
      <div class="media-box">
        <h3>Validación Visual de Identidad (Selfie Proctoring Transparente vs. Cédula)</h3>
        <p style="font-size:0.85rem; color: var(--text-muted); margin-bottom: 0.75rem;">
          Contraste la Selfie Informada tomada en el Mini-Test Técnico (Fase 1.5) contra la foto de la Cédula de Identidad cargada en la Pre-Acreditación (Fase 2).
        </p>
        <div class="media-comparison-grid">
          <div>
            <strong style="font-size: 0.85rem;">Selfie Transparente (Mini-Test Fase 1.5):</strong>
            ${candidate.initial_selfie 
              ? `<img src="${candidate.initial_selfie}" alt="Selfie Mini-Test">` 
              : '<p class="loading-td">Sin selfie de test</p>'}
          </div>
          <div>
            <strong style="font-size: 0.85rem;">Cédula de Identidad (Fase 2 Pre-Acreditación):</strong>
            ${carnetUrl 
              ? `<img src="${carnetUrl}" alt="Cédula de Identidad">` 
              : '<p class="loading-td">No requerida / Pendiente Fase 2</p>'}
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
          <p><strong>1. Credencial Técnica (Fase 1):</strong><br>${escapeHtml(candidate.ocr_credencial_status || candidate.required_credential || 'Verificada')}</p>
          <p><strong>2. Cruce Nombre / RUT (OCR):</strong><br>${escapeHtml(candidate.ocr_detected_name || candidate.full_name)} (${escapeHtml(candidate.ocr_detected_rut || candidate.rut_id)})</p>
          <p><strong>3. Vigencia Cédula (OCR):</strong><br>${escapeHtml(candidate.ocr_carnet_vigencia || 'Pendiente Fase 2')}</p>
          <p><strong>4. Cert. Antecedentes (OCR):</strong><br>${escapeHtml(candidate.ocr_antecedentes_status || 'Pendiente Fase 2')}</p>
        </div>

        <div style="margin-top: 0.85rem; padding: 0.75rem; border-radius: var(--radius-standard); border: 1px solid ${candidate.ocr_cross_check_ok ? 'var(--status-normal-border)' : 'var(--status-warning-border)'}; background: ${candidate.ocr_cross_check_ok ? 'var(--status-normal-bg)' : 'var(--status-warning-bg)'}; color: ${candidate.ocr_cross_check_ok ? 'var(--status-normal-text)' : 'var(--status-warning-text)'}; font-size: 0.85rem;">
          <strong>Diagnóstico del Motor de Reglas y Consistencia:</strong><br>
          ${escapeHtml(candidate.discrepancy_notes || 'Expediente consistente.')}
          ${candidate.ocr_manually_edited ? `<br><em>Nota: El postulante editó manualmente en Fase 1: ${escapeHtml(candidate.ocr_edited_fields || '')}</em>` : ''}
        </div>

        ${candidate.ocr_text ? `
          <details style="margin-top: 0.75rem; background: var(--surface-container); padding: 0.75rem; border-radius: var(--radius-standard); border: 1px solid var(--border-standard);">
            <summary style="cursor: pointer; font-weight: 600; font-family: 'JetBrains Mono', monospace; font-size: 0.82rem;">Ver texto extraído por OCR (Fase 1 + Fase 2)</summary>
            <pre style="white-space: pre-wrap; font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; margin-top: 0.5rem; max-height: 150px; overflow-y: auto;">${escapeHtml(candidate.ocr_text)}</pre>
          </details>
        ` : ''}
      </div>

      <!-- Documentación del Expediente WebControl -->
      <div class="media-box">
        <h3>Archivos del Expediente y Exportación WebControl</h3>
        <div style="display:flex; gap:0.75rem; justify-content:center; flex-wrap:wrap; margin-top:0.65rem;">
          ${credencialUrl ? `<a href="${credencialUrl}" target="_blank" class="btn btn-secondary">Ver Credencial Técnica</a>` : ''}
          ${candidate.cv_file ? `<a href="${candidate.cv_file}" target="_blank" class="btn btn-secondary">Ver CV</a>` : ''}
          ${carnetUrl ? `<a href="${carnetUrl}" target="_blank" class="btn btn-secondary">Ver Cédula</a>` : ''}
          ${candidate.antecedentes_file ? `<a href="${candidate.antecedentes_file}" target="_blank" class="btn btn-secondary">Ver Antecedentes</a>` : ''}
          <a href="/api/admin/candidates/${candidate.id}/export-webcontrol" target="_blank" class="btn btn-primary">
            Generar Carpeta WebControl (PDF / Estandarizado)
          </a>
        </div>
      </div>

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

    modalCandidate.style.display = 'flex';
  };

  window.reprocessCandidateOcr = async (id) => {
    const btn = document.getElementById('btn-reprocess-ocr');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Analizando...';
    }
    try {
      const res = await fetch(`/api/admin/candidates/${id}/reprocess-ocr`, { method: 'POST' });
      if (res.ok) {
        await loadCandidates();
        await loadStats();
        window.viewCandidate(id);
      } else {
        alert('Error al re-analizar OCR del expediente.');
      }
    } catch (e) {
      alert('Error de conexión al re-analizar OCR.');
    }
  };

  window.updateCandidateStatus = async (id, status) => {
    try {
      const res = await fetch(`/api/admin/candidates/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });

      if (res.ok) {
        modalCandidate.style.display = 'none';
        loadCandidates();
        loadStats();
      } else {
        alert('Error actualizando el estado en la máquina de estados.');
      }
    } catch (e) {
      alert('Error de conexión.');
    }
  };

  btnCloseModal.addEventListener('click', () => {
    modalCandidate.style.display = 'none';
  });

  filterPosition.addEventListener('change', loadCandidates);
  filterStatus.addEventListener('change', loadCandidates);
  btnRefresh.addEventListener('click', () => {
    loadCandidates();
    loadStats();
  });

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, function(m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
    });
  }

  loadPositions();
  loadStats();
  loadCandidates();
});
