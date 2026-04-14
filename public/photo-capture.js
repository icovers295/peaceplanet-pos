/*
 * PeacePlanet photo capture widget
 * Provides capturePhoto({entity_type, entity_id, tag}) -> Promise resolving with saved photo metadata
 * Works with laptop webcam (live preview) and mobile camera (file input with capture attribute)
 */
(function(){
  const CSS = `
    .pp-photo-backdrop { position:fixed; inset:0; background:rgba(0,0,0,0.7); backdrop-filter:blur(6px); display:flex; align-items:center; justify-content:center; z-index:9999; padding:16px; }
    .pp-photo-modal { background:#fff; border-radius:20px; padding:20px; max-width:640px; width:100%; box-shadow:0 20px 60px rgba(0,0,0,0.4); font-family:'Inter',-apple-system,sans-serif; }
    .pp-photo-modal h3 { font-size:20px; font-weight:800; letter-spacing:-0.03em; margin-bottom:4px; background:linear-gradient(135deg,#1c1c1e 0%,#5e5ce6 100%); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }
    .pp-photo-sub { color:#8e8e93; font-size:13px; margin-bottom:16px; }
    .pp-tabs { display:flex; gap:6px; background:#f5f5f7; padding:4px; border-radius:12px; margin-bottom:16px; }
    .pp-tab { flex:1; padding:10px; border:none; background:transparent; border-radius:8px; font-weight:600; font-size:13px; cursor:pointer; color:#636366; font-family:inherit; }
    .pp-tab.active { background:#fff; color:#1c1c1e; box-shadow:0 1px 3px rgba(0,0,0,0.08); }
    .pp-stage { background:#000; border-radius:16px; overflow:hidden; aspect-ratio:4/3; display:flex; align-items:center; justify-content:center; position:relative; }
    .pp-stage video, .pp-stage canvas, .pp-stage img { width:100%; height:100%; object-fit:cover; display:block; }
    .pp-empty { color:rgba(255,255,255,0.7); font-size:14px; text-align:center; padding:40px 20px; }
    .pp-controls { display:flex; gap:10px; margin-top:16px; flex-wrap:wrap; }
    .pp-btn { display:inline-flex; align-items:center; gap:6px; padding:11px 18px; border:none; border-radius:10px; font-size:14px; font-weight:600; cursor:pointer; transition:all 0.15s; font-family:inherit; }
    .pp-btn-primary { background:linear-gradient(135deg,#007aff 0%,#5e5ce6 100%); color:white; box-shadow:0 4px 14px rgba(0,122,255,0.35); flex:1; justify-content:center; }
    .pp-btn-primary:hover { transform:translateY(-1px); }
    .pp-btn-primary[disabled] { opacity:0.5; transform:none; cursor:not-allowed; }
    .pp-btn-ghost { background:#f5f5f7; color:#1c1c1e; }
    .pp-btn-danger { background:linear-gradient(135deg,#ff3b30 0%,#ff2d55 100%); color:white; }
    .pp-select { padding:10px; border:1px solid #d2d2d7; border-radius:10px; font-family:inherit; font-size:14px; width:100%; margin-bottom:12px; }
    .pp-input-file { display:none; }
    .pp-hint { font-size:12px; color:#8e8e93; margin-top:8px; text-align:center; }
    .pp-flash { position:absolute; inset:0; background:white; opacity:0; pointer-events:none; transition:opacity 0.05s; }
    .pp-flash.go { opacity:1; transition:opacity 0.4s; }
  `;

  function injectCss(){ if (document.getElementById('pp-photo-css')) return; const s = document.createElement('style'); s.id='pp-photo-css'; s.textContent=CSS; document.head.appendChild(s); }

  function isMobile(){ return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent); }

  window.capturePhoto = function capturePhoto({ entity_type, entity_id, tag = 'before', title = 'Take Photo' }) {
    injectCss();
    const token = localStorage.getItem('pp_token') || localStorage.getItem('pos_token');
    return new Promise((resolve, reject) => {
      const bd = document.createElement('div');
      bd.className = 'pp-photo-backdrop';
      bd.innerHTML = `
        <div class="pp-photo-modal" role="dialog" aria-label="Photo capture">
          <h3>${title}</h3>
          <div class="pp-sub">${tag ? 'Tag: <strong>'+tag+'</strong>' : ''}</div>
          <div class="pp-tabs">
            <button class="pp-tab ${isMobile()?'':'active'}" data-tab="webcam"><i class="fa fa-camera"></i> Webcam</button>
            <button class="pp-tab ${isMobile()?'active':''}" data-tab="file"><i class="fa fa-mobile-alt"></i> Phone / Upload</button>
          </div>
          <div class="pp-stage">
            <video playsinline autoplay muted style="display:${isMobile()?'none':'block'}"></video>
            <canvas style="display:none"></canvas>
            <img style="display:none" alt="preview">
            <div class="pp-empty" style="display:${isMobile()?'flex':'none'};flex-direction:column;gap:12px"><i class="fa fa-camera" style="font-size:40px;opacity:0.4"></i>Tap "Open camera" below to take a photo</div>
            <div class="pp-flash"></div>
          </div>
          <select class="pp-select" style="margin-top:12px; display:${isMobile()?'none':'block'}"></select>
          <input type="file" accept="image/*" capture="environment" class="pp-input-file">
          <div class="pp-controls">
            <button class="pp-btn pp-btn-ghost" data-action="cancel">Cancel</button>
            <button class="pp-btn pp-btn-ghost" data-action="switch" style="display:none">Retake</button>
            <button class="pp-btn pp-btn-primary" data-action="snap">📸 Snap Photo</button>
            <button class="pp-btn pp-btn-primary" data-action="open-file" style="display:none">Open camera</button>
            <button class="pp-btn pp-btn-primary" data-action="save" style="display:none" disabled>Save Photo</button>
          </div>
          <div class="pp-hint">Camera will run locally — photo is only saved when you click Save.</div>
        </div>`;
      document.body.appendChild(bd);
      const $ = sel => bd.querySelector(sel);
      const video = $('video');
      const canvas = $('canvas');
      const img = $('img');
      const flash = $('.pp-flash');
      const fileInput = $('.pp-input-file');
      const select = $('.pp-select');
      const snap = $('[data-action=snap]');
      const save = $('[data-action=save]');
      const retake = $('[data-action=switch]');
      const openFile = $('[data-action=open-file]');

      let stream = null;
      let mode = isMobile() ? 'file' : 'webcam';
      let dataUrl = null;
      let lastDeviceId = localStorage.getItem('pp_camera_deviceId') || null;

      function stopStream(){ if (stream) { stream.getTracks().forEach(t=>t.stop()); stream = null; } }

      async function listDevices(){
        try {
          const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='videoinput');
          select.innerHTML = devs.map((d,i)=>`<option value="${d.deviceId}">${d.label||('Camera '+(i+1))}</option>`).join('');
          if (lastDeviceId && devs.some(d=>d.deviceId===lastDeviceId)) select.value = lastDeviceId;
        } catch(e){}
      }

      async function startWebcam(deviceId){
        stopStream();
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' }, audio: false });
          video.srcObject = stream;
          await listDevices();
          if (deviceId) localStorage.setItem('pp_camera_deviceId', deviceId);
        } catch (e) {
          alert('Could not access webcam: ' + e.message + '\nTry the Phone / Upload tab.');
        }
      }

      function switchMode(next){
        mode = next;
        bd.querySelectorAll('.pp-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === next));
        if (next === 'webcam') {
          video.style.display = 'block';
          img.style.display = 'none';
          $('.pp-empty').style.display = 'none';
          select.style.display = 'block';
          snap.style.display = 'inline-flex';
          openFile.style.display = 'none';
          retake.style.display = 'none';
          save.style.display = 'none';
          startWebcam();
        } else {
          stopStream();
          video.style.display = 'none';
          select.style.display = 'none';
          img.style.display = dataUrl ? 'block' : 'none';
          $('.pp-empty').style.display = dataUrl ? 'none' : 'flex';
          snap.style.display = 'none';
          openFile.style.display = 'inline-flex';
          retake.style.display = dataUrl ? 'inline-flex' : 'none';
          save.style.display = dataUrl ? 'inline-flex' : 'none';
        }
      }

      bd.querySelectorAll('.pp-tab').forEach(t => t.addEventListener('click', () => switchMode(t.dataset.tab)));
      select.addEventListener('change', () => startWebcam(select.value));

      snap.addEventListener('click', () => {
        const w = video.videoWidth, h = video.videoHeight;
        if (!w || !h) return;
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(video, 0, 0, w, h);
        dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        img.src = dataUrl;
        img.style.display = 'block';
        video.style.display = 'none';
        flash.classList.add('go'); setTimeout(()=>flash.classList.remove('go'), 400);
        snap.style.display = 'none';
        retake.style.display = 'inline-flex';
        save.style.display = 'inline-flex';
        save.disabled = false;
      });

      openFile.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', e => {
        const f = e.target.files[0]; if (!f) return;
        const r = new FileReader();
        r.onload = () => {
          dataUrl = r.result;
          img.src = dataUrl;
          img.style.display = 'block';
          $('.pp-empty').style.display = 'none';
          openFile.style.display = 'inline-flex';
          retake.style.display = 'inline-flex';
          save.style.display = 'inline-flex';
          save.disabled = false;
        };
        r.readAsDataURL(f);
      });

      retake.addEventListener('click', () => {
        dataUrl = null;
        img.style.display = 'none';
        save.disabled = true;
        if (mode === 'webcam') {
          video.style.display = 'block';
          snap.style.display = 'inline-flex';
          retake.style.display = 'none';
          save.style.display = 'none';
          startWebcam(select.value);
        } else {
          fileInput.value = '';
          $('.pp-empty').style.display = 'flex';
          retake.style.display = 'none';
          save.style.display = 'none';
        }
      });

      save.addEventListener('click', async () => {
        if (!dataUrl) return;
        save.disabled = true; save.textContent = 'Saving…';
        try {
          const r = await fetch('/api/photos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ entity_type, entity_id, tag, data: dataUrl })
          });
          if (!r.ok) throw new Error((await r.json()).error || 'Upload failed');
          const saved = await r.json();
          cleanup();
          resolve(saved);
        } catch (e) {
          save.disabled = false; save.textContent = 'Save Photo';
          alert(e.message);
        }
      });

      function cleanup(){ stopStream(); bd.remove(); }
      bd.addEventListener('click', e => { if (e.target === bd) { cleanup(); reject(new Error('cancelled')); } });
      bd.querySelector('[data-action=cancel]').addEventListener('click', () => { cleanup(); reject(new Error('cancelled')); });

      // initial mode
      if (mode === 'webcam') startWebcam();
    });
  };

  // Helper to render a photo gallery for an entity
  window.renderPhotoGallery = async function renderPhotoGallery(container, { entity_type, entity_id, allowCapture = true, tag = 'before', canDelete = true }) {
    injectCss();
    const token = localStorage.getItem('pp_token') || localStorage.getItem('pos_token');
    const idKey = String(entity_id).replace(/[^a-zA-Z0-9]/g,'');
    container.innerHTML = '<div style="padding:12px;color:#8e8e93">Loading photos…</div>';
    try {
      const r = await fetch(`/api/photos?entity_type=${entity_type}&entity_id=${encodeURIComponent(entity_id)}`, { headers: { 'Authorization': 'Bearer ' + token } });
      const body = await r.json();
      const photos = Array.isArray(body) ? body : (Array.isArray(body.photos) ? body.photos : []);
      if (!r.ok) throw new Error(body.error || 'Failed to load photos');
      container.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px">
          ${photos.map(p => `
            <div style="position:relative;border-radius:12px;overflow:hidden;background:#f5f5f7;aspect-ratio:1">
              <img src="/api/photos/${p.id}/raw?token=${encodeURIComponent(token)}" style="width:100%;height:100%;object-fit:cover;display:block;cursor:pointer" onclick="window.open('/api/photos/${p.id}/raw?token=${encodeURIComponent(token)}','_blank')">
              <div style="position:absolute;bottom:0;left:0;right:0;padding:6px 8px;background:linear-gradient(transparent,rgba(0,0,0,0.6));color:white;font-size:11px;font-weight:600">${p.tag||''}</div>
              ${canDelete ? `<button onclick="deletePhoto('${p.id}', this)" style="position:absolute;top:4px;right:4px;width:24px;height:24px;border-radius:50%;border:none;background:rgba(255,59,48,0.9);color:white;cursor:pointer;font-size:12px">✕</button>` : ''}
            </div>
          `).join('') || '<div style="grid-column:1/-1;color:#8e8e93;font-size:13px;padding:12px">No photos yet.</div>'}
        </div>
        ${allowCapture ? `<button class="pp-btn pp-btn-primary" style="margin-top:12px" onclick="addPhoto_${idKey}()"><i class="fa fa-camera"></i> Add photo</button>` : ''}
      `;
      window[`addPhoto_${idKey}`] = async () => {
        try {
          await capturePhoto({ entity_type, entity_id, tag });
          renderPhotoGallery(container, { entity_type, entity_id, allowCapture, tag, canDelete });
        } catch(e) { /* cancelled */ }
      };
      window.deletePhoto = async (id, btn) => {
        if (!confirm('Delete this photo?')) return;
        await fetch('/api/photos/' + id, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token } });
        btn.parentElement.remove();
      };
    } catch (e) { container.innerHTML = '<div style="color:#ff3b30">'+e.message+'</div>'; }
  };
})();
