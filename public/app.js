document.addEventListener('DOMContentLoaded', () => {
  const state = {
    step: 1,
    positions: [],
    selectedPosition: null,
    candidateId: null,
    candidateData: {},
    credencialBase64: null,
    cvBase64: null,
    phase1OcrData: null,
    isRunningOcr: false,
    initialSelfieBase64: null,
    carnetFrontBase64: null,
    carnetBackBase64: null,
    antecedentesBase64: null,
    questions: [],
    currentQuestionIndex: 0,
    answers: [],
    timerInterval: null,
    timeLeft: 40,
    mediaStream: null
  };

  // Pasos del Wizard
  const wizardSteps = [
    document.getElementById('wizard-step-1'),
    document.getElementById('wizard-step-2'),
    document.getElementById('wizard-step-3'),
    document.getElementById('wizard-step-4')
  ];
  const navItems = [
    document.getElementById('step-nav-1'),
    document.getElementById('step-nav-2'),
    document.getElementById('step-nav-3')
  ];

  // DOM Fase 1
  const positionSelect = document.getElementById('position_id');
  const ecfRequirementHint = document.getElementById('ecf-requirement-hint');
  const labelCredencial = document.getElementById('label-credencial');
  const fileCredencial = document.getElementById('file-credencial');
  const credencialStatus = document.getElementById('credencial-status');
  const fileCv = document.getElementById('file-cv');
  const cvStatus = document.getElementById('cv-status');

  const ocrLiveBanner = document.getElementById('ocr-live-banner');
  const ocrLiveIcon = document.getElementById('ocr-live-icon');
  const ocrLiveText = document.getElementById('ocr-live-text');
  const ocrFieldsContainer = document.getElementById('ocr-fields-container');
  const ocrBadgeIndicator = document.getElementById('ocr-badge-indicator');

  const fullNameInput = document.getElementById('full_name');
  const rutInput = document.getElementById('rut_id');
  const emailInput = document.getElementById('email');
  const phoneInput = document.getElementById('phone');
  const cityInput = document.getElementById('city');
  const expInput = document.getElementById('experience_years');

  const hintName = document.getElementById('hint-name');
  const hintRut = document.getElementById('hint-rut');
  const hintEmail = document.getElementById('hint-email');
  const hintPhone = document.getElementById('hint-phone');
  const hintCity = document.getElementById('hint-city');
  const hintExp = document.getElementById('hint-exp');

  // Cámara Proctoring Transparente
  const webcamView = document.getElementById('webcam-view');
  const proctoringLiveVideo = document.getElementById('proctoring-live-video');
  const photoCanvas = document.getElementById('photo-canvas');
  const selfiePreview = document.getElementById('selfie-preview');
  const btnStartCamera = document.getElementById('btn-start-camera');
  const btnTakeSelfie = document.getElementById('btn-take-selfie');
  const consentProctoring = document.getElementById('consent-proctoring');
  const formStep1 = document.getElementById('form-step-1');

  // DOM Fase 1.5 (Mini-Test)
  const qCurrent = document.getElementById('q-current');
  const qTotal = document.getElementById('q-total');
  const questionText = document.getElementById('question-text');
  const optionsContainer = document.getElementById('options-container');
  const quizTimer = document.getElementById('quiz-timer');
  const btnNextQuestion = document.getElementById('btn-next-question');

  // DOM Fase 2 (Pre-Acreditación)
  const phase1ScoreBadge = document.getElementById('phase1-score-badge');
  const formPhase2 = document.getElementById('form-phase2');
  const fileCarnetFront = document.getElementById('file-carnet-front');
  const carnetFrontStatus = document.getElementById('carnet-front-status');
  const fileCarnetBack = document.getElementById('file-carnet-back');
  const carnetBackStatus = document.getElementById('carnet-back-status');
  const fileAntecedentes = document.getElementById('file-antecedentes');
  const antecedentesStatus = document.getElementById('antecedentes-status');
  const consentLey19628 = document.getElementById('consent-ley19628');
  const btnSubmitPhase2 = document.getElementById('btn-submit-phase2');

  // DOM Resultado Final
  const finalIcon = document.getElementById('final-icon');
  const finalTitle = document.getElementById('final-title');
  const finalSubtitle = document.getElementById('final-subtitle');
  const resultSummary = document.getElementById('result-summary');

  function formatTitleCase(str) {
    if (!str) return '';
    return str
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .map(w => w ? w.charAt(0).toUpperCase() + w.slice(1) : '')
      .join(' ');
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = err => reject(err);
      reader.readAsDataURL(file);
    });
  }

  // 1. Cargar Cargos y Requisitos ECF Codelco
  async function loadPositions() {
    try {
      const res = await fetch('/api/positions');
      const data = await res.json();
      state.positions = data;
      positionSelect.innerHTML = '<option value="">Seleccione especialidad / cargo a postular...</option>' +
        data.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    } catch (err) {
      positionSelect.innerHTML = '<option value="">Error cargando cargos</option>';
    }
  }

  positionSelect.addEventListener('change', () => {
    const posId = parseInt(positionSelect.value, 10);
    const pos = state.positions.find(p => p.id === posId);
    state.selectedPosition = pos || null;

    if (pos) {
      const minExp = pos.min_experience_years || 2;
      const credName = pos.required_credential || 'Certificación Técnica Habilitante';
      const ecfCode = pos.ecf_code || 'ECF Codelco / DS N° 132';
      ecfRequirementHint.innerHTML = `<strong>${ecfCode}:</strong> Exige mínimo <strong>${minExp} años de experiencia</strong> y adjuntar <strong>${credName}</strong>.`;
      ecfRequirementHint.style.color = 'var(--primary)';
      labelCredencial.textContent = `${credName} *`;
      hintExp.textContent = `Mínimo exigido para este cargo: ${minExp} años de experiencia comprobable.`;
    }
  });

  // 2. Ejecutar OCR en Fase 1 (Credencial Técnica + CV)
  async function triggerPhase1OCR() {
    if (!state.credencialBase64 && !state.cvBase64) return;

    if (state.isRunningOcr) {
      state.pendingOcrRerun = true;
      return;
    }

    state.isRunningOcr = true;
    state.pendingOcrRerun = false;
    ocrLiveBanner.style.display = 'flex';
    ocrLiveBanner.className = 'ocr-banner ocr-banner-loading';
    ocrLiveIcon.textContent = '[PROCESANDO]';
    ocrLiveText.textContent = 'Extrayendo datos de su Credencial Técnica y/o CV mediante OCR local...';
    ocrFieldsContainer.style.display = 'block';

    try {
      const res = await fetch('/api/ocr/phase1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credencial_file: state.credencialBase64,
          cv_file: state.cvBase64
        })
      });

      const data = await res.json();
      if (res.ok) {
        state.phase1OcrData = data;

        if (data.full_name && !fullNameInput.dataset.edited) {
          fullNameInput.value = formatTitleCase(data.full_name);
          hintName.textContent = 'Nombre extraído automáticamente por OCR';
          hintName.style.color = 'var(--status-normal-text)';
        }
        if (data.rut_id && !rutInput.dataset.edited) {
          rutInput.value = data.rut_id;
          hintRut.textContent = 'RUT extraído por OCR (Se cruzará en Fase 2)';
          hintRut.style.color = 'var(--status-normal-text)';
        }
        if (data.email && !emailInput.dataset.edited) {
          emailInput.value = data.email;
          hintEmail.textContent = 'Correo detectado automáticamente en CV';
          hintEmail.style.color = 'var(--status-normal-text)';
        }
        if (data.phone && !phoneInput.dataset.edited) {
          phoneInput.value = data.phone;
          hintPhone.textContent = 'Teléfono detectado automáticamente en CV';
          hintPhone.style.color = 'var(--status-normal-text)';
        }
        if (cityInput && !cityInput.dataset.edited) {
          if (data.city) {
            cityInput.value = data.city;
            if (hintCity) {
              hintCity.textContent = 'Ciudad de residencia detectada en encabezado/contacto del CV';
              hintCity.style.color = 'var(--status-normal-text)';
            }
          } else {
            cityInput.value = '';
            if (hintCity) {
              hintCity.textContent = 'CV sin ciudad de residencia explícita (ingrésela manualmente)';
              hintCity.style.color = 'var(--text-muted)';
            }
          }
        }
        if (data.experience_years !== null && data.experience_years !== undefined && !expInput.dataset.edited) {
          expInput.value = data.experience_years;
          if (data.experience_months !== null && data.experience_months !== undefined) {
            hintExp.textContent = `Experiencia calculada en sección laboral: ${data.experience_years} años (${data.experience_months} meses efectivos, sin prácticas)`;
          } else {
            hintExp.textContent = `Experiencia calculada por OCR desde CV: ${data.experience_years} años`;
          }
          hintExp.style.color = 'var(--status-normal-text)';
        }

        ocrLiveBanner.className = 'ocr-banner ocr-banner-done';
        ocrLiveIcon.textContent = '[OCR OK]';
        ocrLiveText.textContent = `OCR Fase 1 completado (${data.credencial_status || 'Documento procesado'} — ${data.credencial_vigencia || 'Vigente'}). Verifique sus datos abajo o edite cualquier campo si es necesario.`;
      } else {
        ocrLiveBanner.className = 'ocr-banner ocr-banner-warn';
        ocrLiveIcon.textContent = '[AVISO]';
        ocrLiveText.textContent = 'Complete o verifique manualmente sus datos en el formulario inferior.';
      }
    } catch (e) {
      ocrLiveBanner.className = 'ocr-banner ocr-banner-warn';
      ocrLiveIcon.textContent = '[AVISO]';
      ocrLiveText.textContent = 'No se pudo conectar al motor OCR. Puede completar o corregir sus datos manualmente abajo.';
    } finally {
      state.isRunningOcr = false;
      if (state.pendingOcrRerun) {
        state.pendingOcrRerun = false;
        await triggerPhase1OCR();
      }
    }
  }

  fileCredencial.addEventListener('change', async (e) => {
    if (e.target.files[0]) {
      state.credencialBase64 = await fileToBase64(e.target.files[0]);
      credencialStatus.textContent = `Credencial cargada: ${e.target.files[0].name}`;
      credencialStatus.style.color = '#10b981';
      await triggerPhase1OCR();
    }
  });

  fileCv.addEventListener('change', async (e) => {
    if (e.target.files[0]) {
      state.cvBase64 = await fileToBase64(e.target.files[0]);
      cvStatus.textContent = `CV cargado: ${e.target.files[0].name}`;
      cvStatus.style.color = '#10b981';
      await triggerPhase1OCR();
    }
  });

  // Marcar edición manual por el candidato
  function bindManualEdit(inputEl, hintEl, label) {
    if (!inputEl) return;
    inputEl.addEventListener('input', () => {
      inputEl.dataset.edited = 'true';
      ocrBadgeIndicator.textContent = 'Verificado / Editado por Postulante';
      ocrBadgeIndicator.className = 'status-pill status-Pendiente';
      if (hintEl) {
        hintEl.textContent = `${label} editado/confirmado manualmente`;
        hintEl.style.color = 'var(--secondary)';
      }
    });
  }

  bindManualEdit(fullNameInput, hintName, 'Nombre');
  bindManualEdit(rutInput, hintRut, 'RUT');
  bindManualEdit(emailInput, hintEmail, 'Correo');
  bindManualEdit(phoneInput, hintPhone, 'Teléfono');
  bindManualEdit(cityInput, hintCity, 'Ciudad');
  bindManualEdit(expInput, hintExp, 'Experiencia');

  if (fullNameInput) {
    fullNameInput.addEventListener('blur', () => {
      fullNameInput.value = formatTitleCase(fullNameInput.value);
    });
  }

  // 3. Cámara para Proctoring Transparente (Visible en todo momento)
  btnStartCamera.addEventListener('click', async () => {
    try {
      state.mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      webcamView.srcObject = state.mediaStream;
      if (proctoringLiveVideo) {
        proctoringLiveVideo.srcObject = state.mediaStream;
      }
      btnTakeSelfie.disabled = false;
      btnStartCamera.textContent = 'Cámara Visible Activa';
      btnStartCamera.disabled = true;
    } catch (err) {
      alert('No se pudo acceder a la cámara web. Asegúrese de otorgar permisos en el navegador.');
    }
  });

  btnTakeSelfie.addEventListener('click', () => {
    if (!state.mediaStream) return;
    const context = photoCanvas.getContext('2d');
    photoCanvas.width = webcamView.videoWidth || 640;
    photoCanvas.height = webcamView.videoHeight || 480;
    context.drawImage(webcamView, 0, 0, photoCanvas.width, photoCanvas.height);

    state.initialSelfieBase64 = photoCanvas.toDataURL('image/jpeg');
    selfiePreview.src = state.initialSelfieBase64;
    selfiePreview.style.display = 'block';
    webcamView.style.display = 'none';
    btnTakeSelfie.textContent = 'Selfie de Validación Capturada';
    btnTakeSelfie.classList.replace('btn-camera', 'btn-success');
  });

  function goToStep(stepNum) {
    state.step = stepNum;
    wizardSteps.forEach((s, idx) => {
      s.style.display = (idx + 1 === stepNum) ? 'block' : 'none';
    });

    navItems.forEach((n, idx) => {
      if (idx + 1 === stepNum) {
        n.classList.add('active');
      } else if (idx + 1 < stepNum) {
        n.classList.remove('active');
        n.classList.add('completed');
      } else {
        n.classList.remove('active', 'completed');
      }
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // 4. Fase 1 Submit -> Iniciar Fase 1.5 (Mini-Test Técnico de 5 preguntas)
  formStep1.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (state.isRunningOcr) {
      alert('Espere unos segundos a que finalice la lectura OCR de sus documentos.');
      return;
    }

    if (!state.credencialBase64 || !state.cvBase64) {
      alert('Debe adjuntar su Credencial Técnica Habilitante y su Currículum Vitae (CV).');
      return;
    }

    if (!state.initialSelfieBase64) {
      alert('Por favor active su cámara y tome la Selfie de Validación Informada antes de iniciar el Mini-Test.');
      return;
    }

    if (!consentProctoring.checked) {
      alert('Debe aceptar el Consentimiento de Proctoring Transparente para rendir el Mini-Test Técnico.');
      return;
    }

    const formattedName = formatTitleCase(fullNameInput.value);
    fullNameInput.value = formattedName;

    state.candidateData = {
      full_name: formattedName,
      rut_id: rutInput.value.trim(),
      email: emailInput.value.trim(),
      phone: phoneInput.value.trim(),
      city: cityInput.value.trim(),
      experience_years: parseInt(expInput.value || '0', 10),
      position_id: parseInt(positionSelect.value, 10)
    };

    try {
      const res = await fetch(`/api/positions/${state.candidateData.position_id}/questions`);
      const data = await res.json();
      state.questions = data.questions || [];

      if (state.questions.length === 0) {
        alert('No hay preguntas configuradas para esta especialidad.');
        return;
      }

      goToStep(2);
      startMiniTest();
    } catch (err) {
      alert('Error cargando el Mini-Test Técnico.');
    }
  });

  // 5. Lógica del Mini-Test Técnico (Fase 1.5)
  function startMiniTest() {
    state.currentQuestionIndex = 0;
    state.answers = [];
    qTotal.textContent = state.questions.length;
    showQuestion(0);
  }

  function showQuestion(index) {
    if (index >= state.questions.length) {
      clearInterval(state.timerInterval);
      submitPhase1AndEvaluate();
      return;
    }

    const q = state.questions[index];
    qCurrent.textContent = index + 1;
    questionText.textContent = q.question_text;

    optionsContainer.innerHTML = [
      { key: 'A', text: q.option_a },
      { key: 'B', text: q.option_b },
      { key: 'C', text: q.option_c },
      { key: 'D', text: q.option_d }
    ].map(opt => `
      <button type="button" class="option-btn" data-key="${opt.key}">
        <strong>${opt.key})</strong> ${opt.text}
      </button>
    `).join('');

    let selectedOption = null;
    document.querySelectorAll('.option-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.option-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedOption = btn.dataset.key;
      });
    });

    clearInterval(state.timerInterval);
    state.timeLeft = 40;
    quizTimer.textContent = `${state.timeLeft}s`;

    state.timerInterval = setInterval(() => {
      state.timeLeft--;
      quizTimer.textContent = `${state.timeLeft}s`;
      if (state.timeLeft <= 0) {
        clearInterval(state.timerInterval);
        recordAnswerAndAdvance(selectedOption || 'N/A');
      }
    }, 1000);

    btnNextQuestion.onclick = () => {
      clearInterval(state.timerInterval);
      recordAnswerAndAdvance(selectedOption || 'N/A');
    };
  }

  function recordAnswerAndAdvance(selectedOption) {
    const q = state.questions[state.currentQuestionIndex];
    state.answers.push({
      question_id: q.id,
      selected_option: selectedOption
    });
    state.currentQuestionIndex++;
    showQuestion(state.currentQuestionIndex);
  }

  // 6. Evaluar Fase 1 + 1.5 y decidir si desbloquea Fase 2 (Pre-Acreditación) o Descarta Técnicamente
  async function submitPhase1AndEvaluate() {
    btnNextQuestion.disabled = true;
    btnNextQuestion.textContent = 'Evaluando Filtro Técnico ECF...';

    // Detener stream de cámara tras finalizar el Mini-Test
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach(t => t.stop());
    }

    try {
      const res = await fetch('/api/candidates/phase1-submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...state.candidateData,
          cv_file: state.cvBase64,
          credencial_file: state.credencialBase64,
          initial_selfie: state.initialSelfieBase64,
          consent_proctoring: true,
          answers: state.answers,
          phase1_ocr_data: state.phase1OcrData
        })
      });

      const data = await res.json();
      if (!res.ok) {
        alert(`Error al evaluar Fase 1: ${data.error}`);
        return;
      }

      state.candidateId = data.candidateId;

      if (data.qualifiedForPhase2) {
        // Pasa a Fase 2: Pre-Acreditación Formal (Solicitar Carnet + Antecedentes)
        phase1ScoreBadge.textContent = `${data.score}/${data.totalQuestions} (${data.scorePercent}%)`;
        goToStep(3);
      } else {
        // DESCARTADO_TECNICO: Mostrar feedback inmediato sin pedir Carnet ni Antecedentes
        finalIcon.textContent = 'ESTADO: DESCARTADO TÉCNICO';
        finalIcon.className = 'status-pill status-Rechazado';
        finalTitle.textContent = 'Resultado Filtro Técnico: No Califica en esta Convocatoria';
        finalSubtitle.textContent = 'Su postulación no alcanzó el umbral técnico o de experiencia exigido por los Estándares de Control de Fatalidades (ECF) para esta parada de planta.';
        resultSummary.innerHTML = `
          <div class="info-grid">
            <div class="info-item">
              <span class="label">Folio Postulación</span>
              <span class="value">#${data.candidateId}</span>
            </div>
            <div class="info-item">
              <span class="label">Resultado Mini-Test</span>
              <span class="value">${data.score} / ${data.totalQuestions} (${data.scorePercent}% — Mínimo 80%)</span>
            </div>
            <div class="info-item">
              <span class="label">Estado Máquina de Estados</span>
              <span class="status-pill status-Rechazado">${data.status}</span>
            </div>
          </div>
          <div style="margin-top: 1.25rem; text-align: left; background: var(--status-error-bg); border: 1px solid var(--status-error-border); color: var(--status-error-text); padding: 1rem; border-radius: var(--radius-standard); font-size: 0.9rem;">
            <strong>Motivo técnico del descarte automático:</strong><br>
            ${(data.rejectionReasons || []).join('<br>')}
          </div>
          <p style="margin-top: 1rem; color: var(--text-muted); font-size: 0.85rem;">
            En cumplimiento de la normativa laboral chilena (Dirección del Trabajo y Ley N° 19.628), no se le ha solicitado Cédula de Identidad ni Certificado de Antecedentes Penales.
          </p>
        `;
        goToStep(4);
      }
    } catch (err) {
      alert('Error de conexión al evaluar el Mini-Test.');
    } finally {
      btnNextQuestion.disabled = false;
      btnNextQuestion.textContent = 'Confirmar Respuesta y Siguiente';
    }
  }

  // 7. Fase 2 & 3: Subida de Carnet + Antecedentes y Motor OCR de Validación Cruzada
  fileCarnetFront.addEventListener('change', async (e) => {
    if (e.target.files[0]) {
      state.carnetFrontBase64 = await fileToBase64(e.target.files[0]);
      carnetFrontStatus.textContent = `Cédula Frente cargada: ${e.target.files[0].name}`;
      carnetFrontStatus.style.color = '#10b981';
    }
  });

  fileCarnetBack.addEventListener('change', async (e) => {
    if (e.target.files[0]) {
      state.carnetBackBase64 = await fileToBase64(e.target.files[0]);
      carnetBackStatus.textContent = `Cédula Reverso cargada: ${e.target.files[0].name}`;
      carnetBackStatus.style.color = '#10b981';
    }
  });

  fileAntecedentes.addEventListener('change', async (e) => {
    if (e.target.files[0]) {
      state.antecedentesBase64 = await fileToBase64(e.target.files[0]);
      antecedentesStatus.textContent = `Cert. Antecedentes cargado: ${e.target.files[0].name}`;
      antecedentesStatus.style.color = '#10b981';
    }
  });

  formPhase2.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!state.carnetFrontBase64 || !state.antecedentesBase64) {
      alert('Por favor adjunte la foto de su Cédula de Identidad y su Certificado de Antecedentes.');
      return;
    }

    if (!consentLey19628.checked) {
      alert('Debe marcar la casilla de Consentimiento Expreso (Ley N° 19.628) para continuar.');
      return;
    }

    btnSubmitPhase2.disabled = true;
    btnSubmitPhase2.textContent = 'Ejecutando Motor OCR de Validación Cruzada (Fase 3)...';

    try {
      const res = await fetch(`/api/candidates/${state.candidateId}/phase2-acreditacion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          carnet_file: state.carnetFrontBase64,
          carnet_back_file: state.carnetBackBase64,
          antecedentes_file: state.antecedentesBase64,
          consent_ley19628: true
        })
      });

      const data = await res.json();
      if (!res.ok) {
        alert(`Error en Pre-Acreditación: ${data.error}`);
        btnSubmitPhase2.disabled = false;
        btnSubmitPhase2.textContent = 'Ejecutar Validación Cruzada OCR y Finalizar Pre-Acreditación';
        return;
      }

      const isPreAcreditado = data.status === 'PRE_ACREDITADO';
      finalIcon.textContent = isPreAcreditado ? 'ESTADO: PRE-ACREDITADO' : 'ESTADO: EN REVISIÓN MANUAL';
      finalIcon.className = `status-pill ${isPreAcreditado ? 'status-Aprobado' : 'status-Pendiente'}`;
      finalTitle.textContent = isPreAcreditado
        ? 'Expediente 100% Pre-Acreditado para División El Teniente'
        : 'Documentación Recibida — En Revisión Manual por RR.HH.';
      finalSubtitle.textContent = isPreAcreditado
        ? 'El motor OCR validó exitosamente la consistencia entre su Cédula, Certificación Técnica y Antecedentes. Su Carpeta WebControl está lista.'
        : 'Sus documentos fueron cargados correctamente. Un especialista de Nexxo S.A. verificará visualmente un detalle de lectura OCR.';

      resultSummary.innerHTML = `
        <div class="info-grid">
          <div class="info-item">
            <span class="label">Folio Expediente</span>
            <span class="value">#${data.candidateId}</span>
          </div>
          <div class="info-item">
            <span class="label">Vigencia Cédula (OCR)</span>
            <span class="value">${data.ocrCarnetVigencia || 'En verificación'}</span>
          </div>
          <div class="info-item">
            <span class="label">Antecedentes (OCR)</span>
            <span class="value">${data.ocrAntecedentesStatus || 'Recibido'}</span>
          </div>
          <div class="info-item">
            <span class="label">Estado Máquina de Estados</span>
            <span class="status-pill ${isPreAcreditado ? 'status-Aprobado' : 'status-Pendiente'}">${data.status}</span>
          </div>
        </div>
        ${data.discrepancies && data.discrepancies.length > 0 ? `
          <div style="margin-top: 1.25rem; text-align: left; background: var(--status-warning-bg); border: 1px solid var(--status-warning-border); color: var(--status-warning-text); padding: 1rem; border-radius: var(--radius-standard); font-size: 0.88rem;">
            <strong>Detalle enviado a mesa de revisión de RR.HH. Nexxo:</strong><br>
            ${data.discrepancies.join('<br>')}
          </div>
        ` : `
          <div style="margin-top: 1.25rem; text-align: left; background: var(--status-normal-bg); border: 1px solid var(--status-normal-border); color: var(--status-normal-text); padding: 1rem; border-radius: var(--radius-standard); font-size: 0.88rem;">
            <strong>Cruce de Identidad 100% Consistente:</strong> El RUT y Nombre de su Cédula coinciden con su postulación y certificación técnica de la Fase 1.
          </div>
        `}
      `;

      goToStep(4);
    } catch (err) {
      alert('Error de conexión al procesar la Fase 2.');
      btnSubmitPhase2.disabled = false;
      btnSubmitPhase2.textContent = 'Ejecutar Validación Cruzada OCR y Finalizar Pre-Acreditación';
    }
  });

  loadPositions();
});
