document.addEventListener('DOMContentLoaded', () => {
  // Estado Global de la Postulación
  const state = {
    step: 1,
    positions: [],
    selectedPositionId: null,
    candidateData: {},
    certBase64: null,
    antecedentesBase64: null,
    initialSelfieBase64: null,
    randomSelfieBase64: null,
    audioBase64: null,
    questions: [],
    audioPrompt: '',
    currentQuestionIndex: 0,
    answers: [],
    timerInterval: null,
    timeLeft: 30,
    mediaStream: null,
    mediaRecorder: null,
    audioChunks: [],
    audioTimerInterval: null,
    audioDuration: 0
  };

  // Elementos DOM
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

  const positionSelect = document.getElementById('position_id');
  const webcamView = document.getElementById('webcam-view');
  const photoCanvas = document.getElementById('photo-canvas');
  const selfiePreview = document.getElementById('selfie-preview');
  const btnStartCamera = document.getElementById('btn-start-camera');
  const btnTakeSelfie = document.getElementById('btn-take-selfie');
  const silentWebcam = document.getElementById('silent-webcam');

  const fileCert = document.getElementById('file-cert');
  const certStatus = document.getElementById('cert-status');
  const fileAntecedentes = document.getElementById('file-antecedentes');
  const antecedentesStatus = document.getElementById('antecedentes-status');

  const formStep1 = document.getElementById('form-step-1');

  // Quiz DOM
  const qCurrent = document.getElementById('q-current');
  const qTotal = document.getElementById('q-total');
  const questionText = document.getElementById('question-text');
  const optionsContainer = document.getElementById('options-container');
  const quizTimer = document.getElementById('quiz-timer');
  const btnNextQuestion = document.getElementById('btn-next-question');

  // Audio DOM
  const audioPromptText = document.getElementById('audio-prompt-text');
  const recDot = document.getElementById('rec-dot');
  const recStatusText = document.getElementById('rec-status-text');
  const audioTimer = document.getElementById('audio-timer');
  const btnRecordAudio = document.getElementById('btn-record-audio');
  const btnStopAudio = document.getElementById('btn-stop-audio');
  const audioPreview = document.getElementById('audio-preview');
  const btnSubmitAll = document.getElementById('btn-submit-all');
  const resultSummary = document.getElementById('result-summary');

  // 1. Cargar Cargos al iniciar
  async function loadPositions() {
    try {
      const res = await fetch('/api/positions');
      const data = await res.json();
      state.positions = data;
      positionSelect.innerHTML = '<option value="">Seleccione un cargo al que postula...</option>' +
        data.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    } catch (err) {
      positionSelect.innerHTML = '<option value="">Error cargando cargos</option>';
    }
  }

  // Convertir archivo a Base64
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = error => reject(error);
      reader.readAsDataURL(file);
    });
  }

  fileCert.addEventListener('change', async (e) => {
    if (e.target.files[0]) {
      state.certBase64 = await fileToBase64(e.target.files[0]);
      certStatus.textContent = `✔ Archivo: ${e.target.files[0].name}`;
      certStatus.style.color = '#10b981';
    }
  });

  fileAntecedentes.addEventListener('change', async (e) => {
    if (e.target.files[0]) {
      state.antecedentesBase64 = await fileToBase64(e.target.files[0]);
      antecedentesStatus.textContent = `✔ Archivo: ${e.target.files[0].name}`;
      antecedentesStatus.style.color = '#10b981';
    }
  });

  // Cámara WebRTC para Selfie Inicial
  btnStartCamera.addEventListener('click', async () => {
    try {
      state.mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      webcamView.srcObject = state.mediaStream;
      silentWebcam.srcObject = state.mediaStream;
      btnTakeSelfie.disabled = false;
      btnStartCamera.textContent = '🎥 Cámara Activa';
      btnStartCamera.disabled = true;
    } catch (err) {
      alert('No se pudo acceder a la cámara web. Asegúrese de otorgar permisos.');
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
    btnTakeSelfie.textContent = '✔ Selfie Capturada';
    btnTakeSelfie.classList.replace('btn-camera', 'btn-success');
  });

  // Tomar Captura Aleatoria Silenciosa (Anti-Trampa)
  function captureSilentSelfie() {
    if (!state.mediaStream) return;
    try {
      const context = photoCanvas.getContext('2d');
      photoCanvas.width = silentWebcam.videoWidth || 640;
      photoCanvas.height = silentWebcam.videoHeight || 480;
      context.drawImage(silentWebcam, 0, 0, photoCanvas.width, photoCanvas.height);
      state.randomSelfieBase64 = photoCanvas.toDataURL('image/jpeg');
      console.log('[Anti-Cheat] Captura silenciosa de seguridad tomada correctamente.');
    } catch (e) {
      console.log('[Anti-Cheat] Error en captura silenciosa');
    }
  }

  function formatTitleCase(str) {
    if (!str) return '';
    return str
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .map(w => w ? w.charAt(0).toUpperCase() + w.slice(1) : '')
      .join(' ');
  }

  const fullNameInput = document.getElementById('full_name');
  if (fullNameInput) {
    fullNameInput.addEventListener('blur', () => {
      fullNameInput.value = formatTitleCase(fullNameInput.value);
    });
  }

  // Paso 1 Submit -> Ir a Paso 2 (Prueba Técnica)
  formStep1.addEventListener('submit', async (e) => {
    e.preventDefault();
    const age = parseInt(document.getElementById('age').value, 10);
    if (age < 25) {
      alert('REQUISITO EXCLUYENTE: Debe tener al menos 25 años para postular a faenas mineras.');
      return;
    }

    if (!state.initialSelfieBase64) {
      alert('Por favor active su cámara y tome la Selfie de Identidad obligatoria.');
      return;
    }

    const rawName = document.getElementById('full_name').value;
    const formattedName = formatTitleCase(rawName);
    document.getElementById('full_name').value = formattedName;

    state.candidateData = {
      full_name: formattedName,
      rut_id: document.getElementById('rut_id').value.trim(),
      age,
      position_id: parseInt(positionSelect.value, 10)
    };

    // Cargar preguntas para la posición
    try {
      const res = await fetch(`/api/positions/${state.candidateData.position_id}/questions`);
      const data = await res.json();
      state.questions = data.questions;
      state.audioPrompts = data.audio_prompts || [];
      state.usedAudioPromptIds = [];
      state.currentAudioPrompt = null;
      audioPromptText.innerHTML = '🔒 Presione el botón <strong>"Grabar Audio"</strong> para revelar su pregunta situacional y comenzar la evaluación.';

      if (!state.questions || state.questions.length === 0) {
        alert('No hay preguntas disponibles para este cargo.');
        return;
      }

      goToStep(2);
      startQuiz();
    } catch (err) {
      alert('Error cargando la prueba técnica.');
    }
  });

  // Navegación de Pasos
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
  }

  // Lógica del Quiz
  function startQuiz() {
    state.currentQuestionIndex = 0;
    state.answers = [];
    qTotal.textContent = state.questions.length;
    showQuestion(0);
  }

  function showQuestion(index) {
    if (index >= state.questions.length) {
      clearInterval(state.timerInterval);
      goToStep(3); // Pasar a prueba de audio
      return;
    }

    // Captura silenciosa en la pregunta #2
    if (index === 1) {
      captureSilentSelfie();
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

    // Resetear selección
    let selectedOption = null;
    document.querySelectorAll('.option-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.option-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedOption = btn.dataset.key;
      });
    });

    // Resetear Temporizador (30s)
    clearInterval(state.timerInterval);
    state.timeLeft = 30;
    quizTimer.textContent = `${state.timeLeft}s`;

    state.timerInterval = setInterval(() => {
      state.timeLeft--;
      quizTimer.textContent = `${state.timeLeft}s`;

      if (state.timeLeft <= 0) {
        clearInterval(state.timerInterval);
        // Avanzar automáticamente si expira el tiempo
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

  // Obtener nueva pregunta situacional de audio sin repetir
  function getNewAudioPrompt() {
    if (!state.audioPrompts || state.audioPrompts.length === 0) {
      return { prompt_text: 'Describa su experiencia y procedimientos de seguridad en faenas mineras.' };
    }

    // Filtrar las preguntas que aún no hayan sido utilizadas en este intento
    let unshown = state.audioPrompts.filter(p => !state.usedAudioPromptIds.includes(p.id));

    // Si ya salieron todas, reiniciar la lista evitando repetir la actual
    if (unshown.length === 0) {
      state.usedAudioPromptIds = state.currentAudioPrompt ? [state.currentAudioPrompt.id] : [];
      unshown = state.audioPrompts.filter(p => !state.usedAudioPromptIds.includes(p.id));
      if (unshown.length === 0) unshown = state.audioPrompts;
    }

    const selected = unshown[Math.floor(Math.random() * unshown.length)];
    state.usedAudioPromptIds.push(selected.id);
    state.currentAudioPrompt = selected;
    return selected;
  }

  // Grabador de Audio (MediaRecorder)
  btnRecordAudio.addEventListener('click', async () => {
    // Si se está volviendo a grabar, resetear la pregunta previa para obtener una nueva no repetida
    if (state.audioBase64 || (audioPreview.src && audioPreview.style.display !== 'none')) {
      state.audioBase64 = null;
      state.currentAudioPrompt = null;
      audioPreview.style.display = 'none';
    }

    // Revelar la pregunta situacional al presionar Grabar Audio
    if (!state.currentAudioPrompt) {
      const prompt = getNewAudioPrompt();
      audioPromptText.innerHTML = `📢 <strong>Pregunta Situacional (${state.usedAudioPromptIds.length}/${state.audioPrompts.length}):</strong> ${prompt.prompt_text}`;
    }

    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state.audioChunks = [];
      state.mediaRecorder = new MediaRecorder(audioStream);

      state.mediaRecorder.ondataavailable = e => {
        if (e.data.size > 0) state.audioChunks.push(e.data);
      };

      state.mediaRecorder.onstop = () => {
        const audioBlob = new Blob(state.audioChunks, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = () => {
          state.audioBase64 = reader.result;
          audioPreview.src = URL.createObjectURL(audioBlob);
          audioPreview.style.display = 'block';
        };
      };

      state.mediaRecorder.start();
      recDot.classList.add('recording');
      recStatusText.textContent = '🔴 Grabando respuesta... hable claro al micrófono.';
      btnRecordAudio.style.display = 'none';
      btnStopAudio.style.display = 'inline-flex';

      // Contador de audio
      state.audioDuration = 0;
      state.audioTimerInterval = setInterval(() => {
        state.audioDuration++;
        const mins = String(Math.floor(state.audioDuration / 60)).padStart(2, '0');
        const secs = String(state.audioDuration % 60).padStart(2, '0');
        audioTimer.textContent = `${mins}:${secs}`;

        if (state.audioDuration >= 60) {
          stopAudioRecording();
        }
      }, 1000);

    } catch (err) {
      alert('No se pudo acceder al micrófono para la grabación de voz.');
    }
  });

  btnStopAudio.addEventListener('click', stopAudioRecording);

  function stopAudioRecording() {
    if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
      state.mediaRecorder.stop();
      clearInterval(state.audioTimerInterval);
      recDot.classList.remove('recording');
      recStatusText.textContent = '✔ Grabación finalizada. Escuche la vista previa o toque "Regrabar (Cambiar Pregunta)".';
      btnStopAudio.style.display = 'none';
      btnRecordAudio.style.display = 'inline-flex';
      btnRecordAudio.textContent = '🔄 Regrabar (Cambiar Pregunta)';
    }
  }

  // Envío Final al Backend
  btnSubmitAll.addEventListener('click', async () => {
    if (!state.audioBase64) {
      alert('Por favor grabe su respuesta en audio antes de enviar la postulación.');
      return;
    }

    btnSubmitAll.disabled = true;
    btnSubmitAll.textContent = '⏳ Procesando Envió...';

    const payload = {
      ...state.candidateData,
      cert_file: state.certBase64,
      antecedentes_file: state.antecedentesBase64,
      initial_selfie: state.initialSelfieBase64,
      random_selfie: state.randomSelfieBase64 || state.initialSelfieBase64,
      answers: state.answers,
      audio_file: state.audioBase64
    };

    try {
      const res = await fetch('/api/candidates/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();

      if (res.ok) {
        goToStep(4);
        resultSummary.innerHTML = `
          <div class="info-grid">
            <div class="info-item">
              <span class="label">ID Postulación</span>
              <span class="value">#${data.candidateId}</span>
            </div>
            <div class="info-item">
              <span class="label">Puntaje Técnico</span>
              <span class="value">${data.score} / ${data.totalQuestions} aciertos</span>
            </div>
            <div class="info-item">
              <span class="label">Estado Inicial</span>
              <span class="status-pill status-${data.status}">${data.status}</span>
            </div>
          </div>
          <p style="margin-top: 1rem; color: var(--text-muted); font-size: 0.9rem;">
            El equipo de reclutamiento de Nexxo S.A. revisará su grabación de audio y antecedentes. Le contactaremos a la brevedad.
          </p>
        `;
      } else {
        alert(`Error al enviar: ${data.error}`);
        btnSubmitAll.disabled = false;
        btnSubmitAll.textContent = '🚀 Finalizar y Enviar Postulación';
      }
    } catch (err) {
      alert('Error de conexión al servidor.');
      btnSubmitAll.disabled = false;
      btnSubmitAll.textContent = '🚀 Finalizar y Enviar Postulación';
    }
  });

  loadPositions();
});
