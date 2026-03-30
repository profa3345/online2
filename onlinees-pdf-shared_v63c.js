/**
 * onlinees-pdf-shared.js
 * Motor único de geração de PDF — compartilhado entre index.html e portal.html.
 *
 * Expõe no escopo global:
 *   window._ensureJsPDF()               → carrega jsPDF + autotable sob demanda
 *   window.exportarPDF(r)               → gera e salva o PDF do relatório
 *   window.prepararRelatorioParaPDF(r)  → normaliza campos antes de chamar exportarPDF
 *   window.addImagemReduzidaAoPdf(...)  → helper de imagem (usado internamente)
 *   window.normalizarAssinaturaPNG(...) → helper de assinatura (usado internamente)
 *
 * Dependências opcionais no contexto da página (com fallback):
 *   window.logoBase64      — logo PNG em base64 (sistema principal)
 *   window.logoPromise     — Promise que resolve quando logoBase64 está pronto
 *   window.loadLogoBase64  — função que carrega logo dinamicamente
 *   window.LOGO_DATA_URI   — logo JPEG embutido (portal.html)
 *   window.equipamentos    — array de equipamentos de estoque
 *   window.loadRelatorios  — retorna relatórios do localStorage (recupera imagens)
 *   window.logInfo / window.logError   — log do sistema principal
 *   window.showToast / window.toast    — notificação (aceita ambos os nomes)
 */
(function (global) {
  'use strict';

  // =========================================================================
  // Helpers de data
  // =========================================================================

  function _pad(n) { return String(n).padStart(2, '0'); }

  function _agoraBR() {
    var d = new Date();
    return _pad(d.getDate()) + '/' + _pad(d.getMonth() + 1) + '/' + d.getFullYear() +
      ' ' + _pad(d.getHours()) + ':' + _pad(d.getMinutes());
  }

  function _isoToBR(iso) {
    if (iso == null || iso === '') return '';
    var s = String(iso).trim();
    if (!s) return '';
    // [FIX-TZ1] Se string já tem offset local, extrai sem converter fuso
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (m) return m[3] + '/' + m[2] + '/' + m[1] + ' ' + m[4] + ':' + m[5];
    try {
      var d = new Date(s);
      if (isNaN(d.getTime())) return '';
      return _pad(d.getDate()) + '/' + _pad(d.getMonth() + 1) + '/' + d.getFullYear() +
        ' ' + _pad(d.getHours()) + ':' + _pad(d.getMinutes());
    } catch (e) { return ''; }
  }

  // =========================================================================
  // Notificação
  // =========================================================================

  function _toast(msg, ms) {
    var fn = global.showToast || global.toast;
    if (typeof fn === 'function') fn(msg, ms || 3000);
  }

  // =========================================================================
  // Carregador lazy de jsPDF
  // =========================================================================
  // jsPDF (~350 KB) só é carregado quando o usuário clica em "Gerar PDF".
  // Scripts carregados em SÉRIE: jsPDF primeiro, autotable depois (ordem importa).
  // A promise é cacheada — segunda chamada tem custo zero.

  var _jspdfPromise = null;

  function _ensureJsPDF() {
    if (_jspdfPromise) return _jspdfPromise;
    _jspdfPromise = new Promise(function (resolve, reject) {
      if (global.jspdf && global.jspdf.jsPDF) { resolve(); return; }
      var urls = [
        'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
        'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.28/jspdf.plugin.autotable.min.js'
      ];
      var sriHashes = [
        'sha384-JcnsjUPPylna1s1fvi1u12X5qjY5OL56iySh75FdtrwhO/SWXgMjoVqcKyIIWOLk',
        'sha384-vxxMdt1K6XlME6zkLsgFrrHIeC7XIdAo1GW/uhhObjJXnymxiIi/eoMXsKJA13ZJ'
      ];
      var loaded = 0;
      function loadSerial(i) {
        if (i >= urls.length) return;
        var s = document.createElement('script');
        s.src = urls[i];
        s.crossOrigin = 'anonymous';
        if (sriHashes[i] && !sriHashes[i].includes('HASH_')) s.integrity = sriHashes[i];
        s.onload = function () {
          loaded++;
          if (loaded === urls.length) resolve();
          else loadSerial(i + 1);
        };
        s.onerror = function () {
          var fb = document.createElement('script');
          fb.src = (i === 0)
            ? 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js'
            : 'https://cdn.jsdelivr.net/npm/jspdf-autotable@3.5.28/dist/jspdf.plugin.autotable.min.js';
          fb.onload = function () {
            loaded++;
            if (loaded === urls.length) resolve();
            else loadSerial(i + 1);
          };
          fb.onerror = function () {
            // Limpa promise rejeitada — permite retry sem recarregar a página
            _jspdfPromise = null;
            reject(new Error('[LAZY] jsPDF não carregou nem pelo fallback.'));
          };
          document.head.appendChild(fb);
        };
        document.head.appendChild(s);
      }
      loadSerial(0);
    });
    return _jspdfPromise;
  }

  // =========================================================================
  // addImagemReduzidaAoPdf
  // =========================================================================
  // • Rejeita placeholders '[local]' / '[comprimido]'
  // • Detecta formato real (JPEG / PNG / WEBP)
  // • Converte WEBP → JPEG via canvas (builds antigos do jsPDF não suportam WEBP)
  // • Timeout de 8 s — evita travar em imagens CORS/lentas
  // • permitirAmpliacao = false por padrão (nunca amplia além do tamanho original)

  function addImagemReduzidaAoPdf(doc, imgSrc, x, y, maxWmm, maxHmm, permitirAmpliacao) {
    if (permitirAmpliacao === undefined) permitirAmpliacao = false;

    if (!imgSrc || imgSrc === '[local]' || imgSrc === '[comprimido]' || typeof imgSrc !== 'string') {
      return Promise.resolve(0);
    }

    var _fmtPdf = (function (src) {
      var h = src.slice(0, 50).toLowerCase();
      if (h.includes('image/jpeg') || h.includes('image/jpg')) return 'JPEG';
      if (h.includes('image/webp')) return 'JPEG'; // será convertido via canvas
      return 'PNG';
    })(imgSrc);

    function _prepararSrc(src) {
      return new Promise(function (resolve) {
        if (!src.toLowerCase().startsWith('data:image/webp')) { resolve(src); return; }
        try {
          var ci = new Image();
          ci.onload = function () {
            var cv = document.createElement('canvas');
            cv.width = ci.width; cv.height = ci.height;
            cv.getContext('2d').drawImage(ci, 0, 0);
            resolve(cv.toDataURL('image/jpeg', 0.85));
          };
          ci.onerror = function () { resolve(src); };
          ci.src = src;
        } catch (e) { resolve(src); }
      });
    }

    return new Promise(function (resolve) {
      _prepararSrc(imgSrc).then(function (finalSrc) {
        var img = new Image();
        var _done = false;
        var _timer = setTimeout(function () { if (!_done) { _done = true; resolve(0); } }, 8000);

        img.onload = function () {
          if (_done) return; _done = true; clearTimeout(_timer);
          var w = img.width, h = img.height;
          var _fmt = (finalSrc !== imgSrc) ? 'JPEG' : _fmtPdf;
          if (!w || !h) {
            try { doc.addImage(finalSrc, _fmt, x, y, maxWmm, maxHmm); } catch (e) {
              console.warn('[PDF] addImage falhou:', e.message);
            }
            resolve(maxHmm); return;
          }
          var pxPerMm = 96 / 25.4;
          var ratio = permitirAmpliacao
            ? Math.min((maxWmm * pxPerMm) / w, (maxHmm * pxPerMm) / h)
            : Math.min((maxWmm * pxPerMm) / w, (maxHmm * pxPerMm) / h, 1);
          var drawWmm = (w * ratio) / pxPerMm;
          var drawHmm = (h * ratio) / pxPerMm;
          try { doc.addImage(finalSrc, _fmt, x, y, drawWmm, drawHmm); } catch (e) {
            console.warn('[PDF] addImage falhou:', e.message); resolve(0); return;
          }
          resolve(drawHmm);
        };
        img.onerror = function () { if (!_done) { _done = true; clearTimeout(_timer); resolve(0); } };
        if (typeof finalSrc === 'string' && finalSrc.startsWith('http')) img.crossOrigin = 'anonymous';
        img.src = finalSrc;
      });
    });
  }

  // =========================================================================
  // normalizarAssinaturaPNG
  // =========================================================================
  // Recorta o bounding-box dos traços escuros e escala para tamanho padrão.
  // Timeout de 5 s com fallback para o dataUrl original.

  function normalizarAssinaturaPNG(dataUrl, targetW, targetH) {
    return new Promise(function (resolve) {
      if (!dataUrl) { resolve(null); return; }
      var img = new Image();
      var _done = false;
      var _timer = setTimeout(function () { if (!_done) { _done = true; resolve(dataUrl); } }, 5000);
      img.onerror = function () { if (!_done) { _done = true; clearTimeout(_timer); resolve(dataUrl); } };
      img.onload = function () {
        if (_done) return; _done = true; clearTimeout(_timer);
        var tmp = document.createElement('canvas');
        tmp.width = img.width; tmp.height = img.height;
        var ctx = tmp.getContext('2d');
        ctx.drawImage(img, 0, 0);
        var data = ctx.getImageData(0, 0, img.width, img.height).data;
        var minX = img.width, minY = img.height, maxX = 0, maxY = 0, encontrou = false;
        for (var py = 0; py < img.height; py++) {
          for (var px = 0; px < img.width; px++) {
            var idx = (py * img.width + px) * 4;
            if (data[idx] < 200 || data[idx + 1] < 200 || data[idx + 2] < 200) {
              if (px < minX) minX = px; if (px > maxX) maxX = px;
              if (py < minY) minY = py; if (py > maxY) maxY = py;
              encontrou = true;
            }
          }
        }
        if (!encontrou) { resolve(dataUrl); return; }
        var p = 8;
        minX = Math.max(0, minX - p); minY = Math.max(0, minY - p);
        maxX = Math.min(img.width  - 1, maxX + p);
        maxY = Math.min(img.height - 1, maxY + p);
        var bW = maxX - minX, bH = maxY - minY;
        if (bW < 1 || bH < 1) { resolve(dataUrl); return; }
        var scale = Math.min(targetW / bW, targetH / bH);
        var outW = Math.round(bW * scale), outH = Math.round(bH * scale);
        var out = document.createElement('canvas');
        out.width = targetW; out.height = targetH;
        var octx = out.getContext('2d');
        octx.fillStyle = '#ffffff';
        octx.fillRect(0, 0, targetW, targetH);
        octx.drawImage(tmp, minX, minY, bW, bH,
          Math.round((targetW - outW) / 2), Math.round((targetH - outH) / 2), outW, outH);
        resolve(out.toDataURL('image/png'));
      };
      img.src = dataUrl;
    });
  }

  // =========================================================================
  // prepararRelatorioParaPDF
  // =========================================================================
  // Normaliza campos do relatório antes de chamar exportarPDF.
  // Centraliza a camada de adaptação que antes ficava duplicada em cada página.

  function prepararRelatorioParaPDF(r) {
    var rel = Object.assign({}, r);

    // Garante equipEstoqueDescricao preenchida
    if (rel.fornecidoEstoque === 'sim' && rel.equipEstoqueId && !rel.equipEstoqueDescricao) {
      rel.equipEstoqueDescricao = rel.equipEstoqueId;
    }
    // Garante dataHoraBr preenchida
    if (!rel.dataHoraBr && rel.dataHoraIso) {
      rel.dataHoraBr = _isoToBR(rel.dataHoraIso);
    }
    // Mapeia 'servico' → 'acoes' (portal usa r.servico||r.acoes na UI)
    if (!rel.acoes && rel.servico) {
      rel.acoes = rel.servico;
    }
    return rel;
  }

  // =========================================================================
  // exportarPDF
  // =========================================================================

  async function exportarPDF(r) {
    try {
      await _ensureJsPDF();

      // Nome do técnico: verifica 5 campos em ordem de prioridade
      var nomeTecPdf =
        (r.tecnico      && String(r.tecnico).trim())      ||
        (r.nomeTecnico  && String(r.nomeTecnico).trim())  ||
        (r.tecnicoNome  && String(r.tecnicoNome).trim())  ||
        (r.tecnicoUser  && String(r.tecnicoUser).trim())  ||
        (global.usuarioLogado && (global.usuarioLogado.fullName || global.usuarioLogado.username)) ||
        'Técnico';

      var jsPDF = global.jspdf.jsPDF;

      // Resolve descrição completa do equipamento de estoque (tipo • marca • modelo • SN)
      if (r.fornecidoEstoque === 'sim' && r.equipEstoqueId && typeof global.equipamentos !== 'undefined') {
        try {
          var eq = (global.equipamentos || []).find(function (e) {
            return String(e.id) === String(r.equipEstoqueId);
          });
          if (eq) {
            r.equipEstoqueDescricao = [
              eq.tipo   || '',
              eq.marca  || '',
              eq.modelo || '',
              eq.serie  ? ('SN ' + eq.serie) : ''
            ].filter(Boolean).join(' • ');
          }
        } catch (e) { /* usa fallback */ }
      }

      var doc = new jsPDF('p', 'mm', 'a4');

      // ── Cabeçalho ──────────────────────────────────────────────────────
      doc.setFillColor(15, 23, 42);
      doc.rect(0, 0, 210, 22, 'F');

      // Logo: tenta logoBase64 dinâmico (sistema principal), depois LOGO_DATA_URI (portal)
      var logoSrc = global.logoBase64 || null;

      if (!logoSrc) {
        try {
          var _logoTimeout = new Promise(function (res) { setTimeout(res, 3000); });
          if (global.logoPromise) {
            await Promise.race([global.logoPromise, _logoTimeout]);
            logoSrc = global.logoBase64 || null;
          }
          if (!logoSrc && typeof global.loadLogoBase64 === 'function') {
            await Promise.race([
              global.loadLogoBase64().then(function (b) { if (b) { global.logoBase64 = b; logoSrc = b; } }),
              _logoTimeout
            ]);
          }
        } catch (e) { /* segue */ }
      }

      if (!logoSrc) {
        try {
          var uiLogo = document.getElementById('logoSidebar') || document.getElementById('logoLogin');
          if (uiLogo && uiLogo.src && uiLogo.src.startsWith('data:image/')) logoSrc = uiLogo.src;
        } catch (e) { /* ignora */ }
      }

      if (!logoSrc && typeof global.LOGO_DATA_URI === 'string') {
        logoSrc = global.LOGO_DATA_URI; // fallback para o portal
      }

      if (logoSrc) {
        var logoFmt = logoSrc.toLowerCase().includes('image/png') ? 'PNG' : 'JPEG';
        try { doc.addImage(logoSrc, logoFmt, 10, 3, 18, 16); } catch (e) {
          console.warn('[PDF] Falha ao carregar logo:', e);
        }
      }

      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
      doc.text('ONLINE-ES ELETROELETRÔNICA - CNPJ 34.740.527/0001-74', 105, 8, { align: 'center' });
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
      doc.text('www.onlinees.com.br | (27) 99806-7411', 105, 13, { align: 'center' });
      doc.setFontSize(8);
      doc.text('RELATÓRIO TÉCNICO DE ATENDIMENTO AO CLIENTE.', 105, 18, { align: 'center' });

      doc.setTextColor(15, 23, 42);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
      doc.text('Relatório nº ' + (r.numero || '-'), 10, 28);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
      doc.text('Data do atendimento: ' + (r.dataHoraBr || _isoToBR(r.dataHoraIso)), 130, 28);

      // ── Tabelas ────────────────────────────────────────────────────────
      var y = 34;
      var end = [r.endereco, r.bairro, r.cidade, r.uf].filter(Boolean).join(' • ') || '-';

      var tOpts = {
        theme: 'grid',
        styles: { fontSize: 8, cellPadding: 2 },
        headStyles: { fillColor: [15, 23, 42], textColor: 255 },
        columnStyles: { 0: { cellWidth: 55, fontStyle: 'bold' }, 1: { cellWidth: 130 } }
      };

      function tL(label, texto) {
        return [
          { content: label, styles: { fontStyle: 'bold' } },
          { content: (texto && texto.toString().trim().length ? texto : '-').toString().replace(/\r\n/g, '\n') }
        ];
      }

      // 1. Dados do cliente
      doc.autoTable(Object.assign({}, tOpts, {
        startY: y,
        head: [['1. Dados do cliente', '']],
        body: [
          ['Cliente / Empresa', r.cliente || '-'],
          [r.docClienteTipo === 'CPF' ? 'CPF do cliente' : 'CNPJ do cliente', r.cnpjCliente || '-'],
          ['Contato', r.contato || '-'],
          ['Telefone', r.telefone || '-'],
          ['WhatsApp', r.whatsapp || '-'],
          ['Coordenadas (GPS)', r.localizacaoCoordenadas || '-'],
          ['Google Maps', r.localizacaoLink || '-'],
          ['Endereço', end]
        ]
      }));
      y = doc.lastAutoTable.finalY + 4;

      // 2. Equipamento
      doc.autoTable(Object.assign({}, tOpts, {
        startY: y,
        head: [['2. Equipamento', '']],
        body: [
          ['Modelo / Marca', r.equipamento || '-'],
          ['Nº de série', r.serie || '-'],
          ['Potência / kVA', r.kva || '-'],
          ['Local de instalação', r.localInstalacao || '-'],
          ['Condição na chegada', r.condicao || '-'],
          ['Equipamento fornecido de estoque',
            r.equipEstoqueDescricao || (r.fornecidoEstoque === 'sim' ? (r.equipEstoqueId || '-') : '-')]
        ]
      }));
      y = doc.lastAutoTable.finalY + 4;

      // 3. Serviço executado
      var acoesTexto = (r.acoes && r.acoes.length)
        ? (Array.isArray(r.acoes)
            ? r.acoes.map(function (a) { return '- ' + a; }).join('\n')
            : String(r.acoes))
        : '-';

      doc.autoTable(Object.assign({}, tOpts, {
        startY: y,
        head: [['3. Serviço executado', '']],
        styles: Object.assign({}, tOpts.styles, { valign: 'top' }),
        body: [
          ['Tipo de serviço', r.tipo || '-'],
          tL('Problema informado', r.problema),
          tL('Diagnóstico do técnico', r.diagnostico),
          tL('Ações realizadas', acoesTexto),
          ['Peças utilizadas', r.pecas || '-'],
          ['Status final', r.status || '-']
        ]
      }));
      y = doc.lastAutoTable.finalY + 4;

      // 4. Baterias / Observações
      doc.autoTable(Object.assign({}, tOpts, {
        startY: y,
        head: [['4. Baterias / Observações', '']],
        styles: Object.assign({}, tOpts.styles, { valign: 'top' }),
        body: [
          ['Quantidade de baterias', r.bateriasQtd || '-'],
          ['Tensão', r.bateriasTensao || '-'],
          tL('Observações', r.bateriasObs || r.observacoes || '-')
        ]
      }));
      y = doc.lastAutoTable.finalY + 4;

      // 5. Mídias anexadas
      var temImgs = (r.imgsEquip   && r.imgsEquip.length)   ||
                    (r.imgsServico  && r.imgsServico.length)  ||
                    (r.imgsBaterias && r.imgsBaterias.length);
      var temVids = (r.vidsEquip   && r.vidsEquip.length)   ||
                    (r.vidsServico  && r.vidsServico.length)  ||
                    (r.vidsBaterias && r.vidsBaterias.length);

      if (temImgs || temVids) {
        var lm = [];
        // [FIX-v63c] Conta apenas imagens reais (exclui '[local]' e '[comprimido]')
        var _cntEquip  = (r.imgsEquip    || []).filter(function(s){ return s && s.startsWith('data:'); }).length;
        var _cntServ   = (r.imgsServico  || []).filter(function(s){ return s && s.startsWith('data:'); }).length;
        var _cntBat    = (r.imgsBaterias || []).filter(function(s){ return s && s.startsWith('data:'); }).length;
        var _cntLocEq  = (r.imgsEquip    || []).filter(function(s){ return s === '[local]' || s === '[comprimido]'; }).length;
        var _cntLocSv  = (r.imgsServico  || []).filter(function(s){ return s === '[local]' || s === '[comprimido]'; }).length;
        var _cntLocBt  = (r.imgsBaterias || []).filter(function(s){ return s === '[local]' || s === '[comprimido]'; }).length;
        if (_cntEquip || _cntLocEq)  lm.push(['Fotos de equipamento',     _cntEquip  + ' anexada(s)' + (_cntLocEq  ? ' (' + _cntLocEq  + ' no dispositivo)' : '')]);
        if (_cntServ  || _cntLocSv)  lm.push(['Fotos do serviço',          _cntServ   + ' anexada(s)' + (_cntLocSv  ? ' (' + _cntLocSv  + ' no dispositivo)' : '')]);
        if (_cntBat   || _cntLocBt)  lm.push(['Fotos de baterias/painel',  _cntBat    + ' anexada(s)' + (_cntLocBt  ? ' (' + _cntLocBt  + ' no dispositivo)' : '')]);
        if (r.vidsEquip    && r.vidsEquip.length)    lm.push(['Vídeos de equipamento',     r.vidsEquip.length    + ' anexado(s)']);
        if (r.vidsServico  && r.vidsServico.length)  lm.push(['Vídeos do serviço',          r.vidsServico.length  + ' anexado(s)']);
        if (r.vidsBaterias && r.vidsBaterias.length) lm.push(['Vídeos de baterias/painel', r.vidsBaterias.length + ' anexado(s)']);

        doc.autoTable({
          startY: y,
          head: [['5. Mídias anexadas', 'Qtd./Observação']],
          body: lm,
          theme: 'grid',
          styles: { fontSize: 8, cellPadding: 2 },
          headStyles: { fillColor: [15, 23, 42], textColor: 255 },
          columnStyles: { 0: { cellWidth: 70, fontStyle: 'bold' }, 1: { cellWidth: 115 } }
        });
        y = doc.lastAutoTable.finalY + 4;
      }

      // 6. Anexos fotográficos
      if (temImgs) {
        if (y > 240) { doc.addPage(); y = 15; }
        doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(15, 23, 42);
        doc.text('6. Anexos fotográficos', 10, y); y += 4;
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8);

        // Tenta recuperar versão local completa quando imagens vêm do Firestore como '[local]'
        var _rComImgs = r;
        try {
          var _localList = typeof global.loadRelatorios === 'function' ? global.loadRelatorios() : [];
          var _rLocal = _localList.find(function (x) { return x.id === r.id; });
          if (_rLocal && (
            (_rLocal.imgsEquip    || []).some(function (s) { return s && s.startsWith('data:'); }) ||
            (_rLocal.imgsServico  || []).some(function (s) { return s && s.startsWith('data:'); }) ||
            (_rLocal.imgsBaterias || []).some(function (s) { return s && s.startsWith('data:'); })
          )) { _rComImgs = _rLocal; }
        } catch (e) { /* usa r original */ }

        var allImages = []
          .concat(_rComImgs.imgsEquip    || [])
          .concat(_rComImgs.imgsServico  || [])
          .concat(_rComImgs.imgsBaterias || [])
          .filter(function (src) {
            return src && typeof src === 'string' &&
              src !== '[local]' && src !== '[comprimido]' && src.startsWith('data:');
          });

        if (!allImages.length) {
          doc.setTextColor(150);
          doc.text('As fotos estão salvas no dispositivo do técnico e não puderam ser incluídas neste PDF.', 10, y);
          doc.setTextColor(0); y += 8;
        } else {
          doc.setTextColor(15, 23, 42);
          doc.text('As imagens abaixo foram reduzidas automaticamente para envio em PDF.', 10, y); y += 5;

          // Pré-carrega em paralelo antes do loop sequencial (~40% mais rápido com 6+ fotos)
          await Promise.allSettled(allImages.map(function (src) {
            return new Promise(function (res) {
              if (!src || src === '[local]' || src === '[comprimido]') { res(); return; }
              var pi = new Image(); pi.onload = res; pi.onerror = res; pi.src = src;
            });
          }));

          var col = 0, rowMaxH = 40;
          for (var i = 0; i < allImages.length; i++) {
            if (y > 265) { doc.addPage(); y = 15; }
            var xi = (col === 0) ? 10 : 110;
            var imgH = await addImagemReduzidaAoPdf(doc, allImages[i], xi, y, 85, 55);
            if (imgH > 0) {
              rowMaxH = Math.max(rowMaxH, imgH);
              if (col === 1) { y += rowMaxH + 6; col = 0; rowMaxH = 40; }
              else { col = 1; }
            }
          }
          if (col === 1) y += rowMaxH + 6;
          y += 4;
        }
      }

      // ── Assinaturas ───────────────────────────────────────────────────
      if (y > 230) { doc.addPage(); y = 30; } else { y += 15; }

      var topoAssY = y;
      var SIG_NORM_W = 600, SIG_NORM_H = 168, SIG_W = 60, SIG_H = 28;

      if (r.assinaturaCliente) {
        var sigCliNorm = await normalizarAssinaturaPNG(r.assinaturaCliente, SIG_NORM_W, SIG_NORM_H);
        if (sigCliNorm) try { doc.addImage(sigCliNorm, 'PNG', 20 + (70 - SIG_W) / 2, topoAssY, SIG_W, SIG_H); } catch (e) { /* ignora */ }
      }
      if (r.assinaturaTecnicoImg) {
        var sigTecNorm = await normalizarAssinaturaPNG(r.assinaturaTecnicoImg, SIG_NORM_W, SIG_NORM_H);
        if (sigTecNorm) try { doc.addImage(sigTecNorm, 'PNG', 120 + (70 - SIG_W) / 2, topoAssY, SIG_W, SIG_H); } catch (e) { /* ignora */ }
      }

      var linhaBaseY = topoAssY + SIG_H + 2;

      // Bloco cliente (esquerda)
      doc.setDrawColor(148, 163, 184);
      doc.line(20, linhaBaseY, 90, linhaBaseY);
      var meioCliX = (20 + 90) / 2;
      if (r.nomeAssinaturaCliente) {
        doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
        doc.text(r.nomeAssinaturaCliente, meioCliX, linhaBaseY + 6, { align: 'center' });
      }
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
      doc.text(r.cliente || 'Cliente', meioCliX, linhaBaseY + 12, { align: 'center' });

      // Bloco técnico (direita)
      var meioTecX = (120 + 190) / 2;
      doc.setDrawColor(148, 163, 184);
      doc.line(120, linhaBaseY, 190, linhaBaseY);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
      doc.text(nomeTecPdf, meioTecX, linhaBaseY + 6, { align: 'center' });
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
      doc.text('Técnico', meioTecX, linhaBaseY + 12, { align: 'center' });
      doc.setFontSize(7);
      doc.text('Gerado em ' + _agoraBR(), meioTecX, linhaBaseY + 18, { align: 'center' });

      // ── Rodapé em todas as páginas ────────────────────────────────────
      var pageCount = doc.internal.getNumberOfPages();
      for (var pg = 1; pg <= pageCount; pg++) {
        doc.setPage(pg);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(15, 23, 42);
        doc.setDrawColor(148, 163, 184); doc.setLineWidth(0.3);
        doc.line(20, 283, 190, 283);
        doc.text('ONLINE-ES Eletroeletrônica - www.onlinees.com.br - CNPJ 34.740.527/0001-74', 105, 287, { align: 'center' });
        doc.text('Rua Maria Lourdes Garcia 176, Ilha de Santa Maria, Vitória - Cep 29.051-250',  105, 292, { align: 'center' });
        doc.text('Página ' + pg + '/' + pageCount, 105, 296, { align: 'center' });
      }

      // ── Salva / armazena resultado ────────────────────────────────────
      var _nomePdf = 'relatorio-' +
        (r.numero || r._id || 'online').replace(/[^a-zA-Z0-9\-_]/g, '_') + '.pdf';

      try {
        var dataUri = doc.output('datauristring');
        if (dataUri && dataUri.startsWith('data:')) {
          global._lastPdfBase64   = dataUri.split(',')[1] || null;
          global._lastPdfFilename = _nomePdf;
          global._lastPdfDoc      = doc;
        }
      } catch (e) { console.warn('[PDF] Falha ao capturar base64:', e); }

      if (!r._somenteMemoria) {
        doc.save(_nomePdf);
        try {
          if (typeof global.logInfo === 'function') {
            global.logInfo('PDF da RAT gerado', {
              numero: r.numero || 'N/A', cliente: r.cliente || '', status: r.status || ''
            });
          }
        } catch (e) { /* ignora */ }
      }

    } catch (e) {
      console.error('[PDF] Erro ao gerar PDF:', e);
      if (typeof global.logError === 'function') {
        global.logError('Falha na geração de PDF', {
          erro: String(e),
          stack: e && e.stack ? String(e.stack).substring(0, 500) : ''
        });
      }
      if (!r._somenteMemoria) {
        _toast('❌ Erro ao gerar o PDF. Verifique o console para mais detalhes.', 4000);
      }
      throw e;
    }
  }

  // =========================================================================
  // Exposição global
  // =========================================================================
  global._ensureJsPDF             = _ensureJsPDF;
  global.addImagemReduzidaAoPdf   = addImagemReduzidaAoPdf;
  global.normalizarAssinaturaPNG  = normalizarAssinaturaPNG;
  global.prepararRelatorioParaPDF = prepararRelatorioParaPDF;
  global.exportarPDF              = exportarPDF;

}(window));
