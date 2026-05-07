document.addEventListener('DOMContentLoaded', () => {
    let ultimoResultado = null;

    // ════════════════════════════════════════════════════════
    //  CONSTANTES TÉCNICAS
    // ════════════════════════════════════════════════════════
    const RESISTIVIDADE_COBRE   = 0.0172;  // Ω·mm²/m  (cobre a 20 °C)
    const QUEDA_DC_MAX          = 0.03;    // 3 % — circuito CC  (NBR 16690 §7.4)
    const QUEDA_AC_MAX          = 0.02;    // 2 % — circuito CA  (NBR 5410 §6.2.7)
    const NOCT                  = 45;      // °C — temperatura nominal de operação da célula
    const COEF_TEMP_P           = -0.0040; // -0,40 %/°C — coef. temperatura de potência (Pmpp)
    const COEF_TEMP_V           = -0.0030; // -0,30 %/°C — coef. temperatura de tensão (Voc/Vmp)
    const T_STC                 = 25;      // °C — condição padrão de teste (STC)
    const T_MIN_CELULA          = 5;       // °C — temperatura ambiente mínima conservadora (verific. Voc)
    const T_MAX_CELULA          = 70;      // °C — temperatura máxima de célula (verific. Vmp no MPPT)
    const DEGRADACAO_ANUAL      = 0.005;   // 0,5 %/ano
    const PRECO_WP              = 4.50;    // R$/Wp instalado (mercado 2024/25)
    const TARIFA_KWH            = 0.85;    // R$/kWh — média nacional ANEEL 2024
    const REAJUSTE_TARIFA_ANUAL = 0.06;    // 6 %/ano
    const TMA                   = 0.08;    // 8 % a.a. — Taxa Mínima de Atratividade
    const MESES   = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    const DIAS_MES = [31,28,31,30,31,30,31,31,30,31,30,31];

    // ════════════════════════════════════════════════════════
    //  MÁSCARA CEP
    // ════════════════════════════════════════════════════════
    document.getElementById('cep').addEventListener('input', (e) => {
        let v = e.target.value.replace(/\D/g, '');
        if (v.length > 5) v = v.slice(0, 5) + '-' + v.slice(5, 8);
        e.target.value = v;
    });

    // ════════════════════════════════════════════════════════
    //  CONTROLE DE INTERFACE
    // ════════════════════════════════════════════════════════
    window.toggleFields = () => {
        const sistema = document.getElementById('sistema').value;
        const grupo   = document.getElementById('grupo').value;
        document.getElementById('autonomia-section').style.display =
            (sistema === 'offgrid' || sistema === 'hibrido') ? 'block' : 'none';
        document.getElementById('demanda-field').style.display =
            (grupo === 'A') ? 'block' : 'none';
    };
    document.getElementById('grupo').addEventListener('change', window.toggleFields);
    document.getElementById('sistema').addEventListener('change', window.toggleFields);
    window.toggleFields();

    // ════════════════════════════════════════════════════════
    //  FEEDBACK DE ERRO
    // ════════════════════════════════════════════════════════
    function showError(msg) {
        const el = document.getElementById('error-msg');
        el.textContent = '⚠ ' + msg;
        el.classList.add('show');
        document.getElementById('result-card').classList.remove('show');
    }
    function hideError() {
        document.getElementById('error-msg').classList.remove('show');
    }

    // ════════════════════════════════════════════════════════
    //  ATLAS LABREN — HSP ANUAL + MENSAL
    //  Colunas esperadas: id;nome;lon;lat;Ganual;G01;G02;...;G12
    //
    //  Detecção automática de unidade pelo valor da coluna Ganual:
    //    > 10 000  → kJ/m².dia    (÷ 3600 → kWh/m².dia = HSP)
    //    100–10000 → Wh/m².dia    (÷ 1000 → kWh/m².dia = HSP)  ← padrão LABREN/SWERA
    //    < 100     → kWh/m².dia   (÷ 1   → já é HSP)
    //
    //  HSP (Horas de Sol Pleno) = irradiação diária / 1000 W/m²
    //  Numericamente: 1 kWh/m².dia = 1 HSP = 1 h/dia equivalente
    // ════════════════════════════════════════════════════════
    function detectarDivisorCSV(valorBruto) {
        if (valorBruto > 10000) return 3600;   // kJ/m².dia  → ÷3600 → kWh/m².dia
        if (valorBruto > 100)   return 1000;   // Wh/m².dia  → ÷1000 → kWh/m².dia  (LABREN padrão)
        return 1;                               // já em kWh/m².dia
    }

    async function buscarNoAtlasPorCoordenadas(latBusca, lonBusca) {
        try {
            const res = await fetch('./atlas_labren.csv');
            if (!res.ok) { console.warn("atlas_labren.csv não encontrado — usando HSP manual."); return null; }
            const texto  = await res.text();
            const linhas = texto.split(/\r?\n/);

            // Detecta o divisor da unidade pela primeira linha de dados válida
            let divisorGlobal = null;
            for (let i = 1; i < linhas.length; i++) {
                if (!linhas[i].trim()) continue;
                const primeiroValor = parseFloat(linhas[i].split(';')[4]);
                if (!isNaN(primeiroValor) && primeiroValor > 0) {
                    divisorGlobal = detectarDivisorCSV(primeiroValor);
                    console.log(`Atlas LABREN: unidade detectada — divisor ${divisorGlobal} (valor bruto: ${primeiroValor})`);
                    break;
                }
            }
            if (divisorGlobal === null) { console.warn("Não foi possível detectar unidade do CSV."); return null; }

            let melhor = null, menorDist = Infinity;

            for (let i = 1; i < linhas.length; i++) {
                if (!linhas[i].trim()) continue;
                const c   = linhas[i].split(';');
                const lon = parseFloat(c[2]);
                const lat = parseFloat(c[3]);
                if (isNaN(lat) || isNaN(lon)) continue;

                const d = Math.sqrt((latBusca - lat) ** 2 + (lonBusca - lon) ** 2);
                if (d < menorDist) {
                    menorDist = d;
                    const hspAnual  = parseFloat(c[4]) / divisorGlobal;
                    const hspMensal = [];
                    for (let m = 0; m < 12; m++) {
                        const v = parseFloat(c[5 + m]);
                        hspMensal.push(isNaN(v) ? hspAnual : v / divisorGlobal);
                    }
                    melhor = { lat, lon, hsp: hspAnual, hspMensal };
                }
            }
            console.log(`Atlas: ponto mais próximo a ${menorDist.toFixed(4)}° →`, melhor);
            return melhor;
        } catch (e) {
            console.error("Erro ao processar Atlas:", e);
            return null;
        }
    }

    // ════════════════════════════════════════════════════════
    //  HSP MENSAL SIMULADO
    //  Variação sazonal baseada na latitude (Hemisfério Sul).
    // ════════════════════════════════════════════════════════
    function gerarHspMensalSimulado(hspAnual, lat) {
        const amp = Math.min(0.35, Math.abs(lat) * 0.008);
        // Hemisfério Sul: verão em Dez/Jan → maiores índices nesses meses
        const fatores = [
            1+amp, 1+amp*0.8, 1+amp*0.3, 1-amp*0.2,
            1-amp*0.6, 1-amp, 1-amp*0.9, 1-amp*0.5,
            1+amp*0.1, 1+amp*0.5, 1+amp*0.8, 1+amp
        ];
        return fatores.map(f => +(hspAnual * f).toFixed(3));
    }

    // ════════════════════════════════════════════════════════
    //  PERFORMANCE RATIO DETALHADO
    //  Perdas decompostas por componente, conforme IEC 61724-1.
    //  Temperatura de célula pelo modelo NOCT a 800 W/m²
    //  (condição típica de análise anual média).
    // ════════════════════════════════════════════════════════
    function calcularPR(sistema, tempMedia = 25) {
        // T_cell = T_amb + (NOCT − 20)   →  condição NOCT: 800 W/m², 20 °C, 1 m/s
        const t_cell    = tempMedia + (NOCT - 20);
        const perd_temp = Math.abs(COEF_TEMP_P * (t_cell - T_STC));

        const perdas = {
            inversor:        sistema === 'ongrid'  ? 0.04 : sistema === 'hibrido' ? 0.05 : 0.06,
            cabeamento_dc:   0.02,
            temperatura:     +perd_temp.toFixed(4),
            sombreamento:    0.03,
            sujidade:        0.03,
            mismatch:        0.02,
            disponibilidade: 0.01,
        };
        if (sistema === 'offgrid' || sistema === 'hibrido') {
            perdas.controlador = sistema === 'hibrido' ? 0.03 : 0.05;
            perdas.baterias    = sistema === 'hibrido' ? 0.05 : 0.10;
        }
        const total = Object.values(perdas).reduce((a, b) => a + b, 0);
        return { pr: parseFloat(Math.max(0.55, 1 - total).toFixed(4)), perdas };
    }

    // ════════════════════════════════════════════════════════
    //  STRING DESIGN  — NBR 16690 / IEC 62109-2
    //     Voc e Vmp calculados a partir das variáveis locais
    //     Voc_frio (T_min=5°C) para o limite máximo do inversor;
    //     Vmp_qte  (T_cell_max=70°C) para o limite mínimo do MPPT.
    // ════════════════════════════════════════════════════════
    function calcularStringDesign(numPaineis, painelWp) {
        // Parâmetros elétricos típicos por faixa de potência (STC)
        let voc, vmp, isc, imp;
        if      (painelWp <= 330) { voc = 40.5; vmp = 33.5; isc = 10.0; imp = 9.5;  }
        else if (painelWp <= 450) { voc = 49.5; vmp = 41.0; isc = 11.0; imp = 10.5; }
        else if (painelWp <= 550) { voc = 50.0; vmp = 42.0; isc = 13.8; imp = 13.1; }
        else                      { voc = 53.0; vmp = 44.5; isc = 14.5; imp = 13.8; }

        const V_MPPT_MIN = 200;   // V — limite inferior da janela MPPT
        const V_MPPT_MAX = 600;   // V — limite superior da janela MPPT
        const V_MAX_INV  = 1000;  // V — tensão máxima absoluta de entrada do inversor

        // ── temperatura por painel ──────────────
        // NBR 16690 §6.3.1 / IEC 62109-2 §4.3.8:
        // Voc sobe a temperaturas baixas → verificar contra V_MAX_INV
        // Vmp cai a temperaturas altas   → verificar contra V_MPPT_MIN
        const voc_frio = +(voc * (1 + COEF_TEMP_V * (T_MIN_CELULA - T_STC))).toFixed(2); // Voc a 5 °C
        const vmp_qte  = +(vmp * (1 + COEF_TEMP_V * (T_MAX_CELULA - T_STC))).toFixed(2); // Vmp a 70 °C

        // ── Limites de painéis por string ───────────────────
        const ps_min      = Math.ceil(V_MPPT_MIN  / vmp_qte);           // Vmp no calor ≥ MPPT_MIN
        const ps_max_mppt = Math.floor(V_MPPT_MAX  / vmp);              // Vmp nominal  ≤ MPPT_MAX
        const ps_max_inv  = Math.floor(V_MAX_INV   / voc_frio);         // Voc no frio  ≤ V_MAX_INV
        const ps_max      = Math.min(ps_max_mppt, ps_max_inv);

        const numStrings = Math.ceil(numPaineis / ps_max);

        let paineisPorString = Math.ceil(numPaineis / numStrings);
        paineisPorString = Math.max(ps_min, paineisPorString);

        // ── calcular tensões/correntes totais ──
        const voc_total      = +(paineisPorString * voc).toFixed(1);
        const vmp_total      = +(paineisPorString * vmp).toFixed(1);
        const isc_total      = +(numStrings       * isc).toFixed(1);
        const imp_total      = +(numStrings       * imp).toFixed(1);
        const voc_total_frio = +(paineisPorString * voc_frio).toFixed(1);  // para checagem de segurança
        const vmp_total_qte  = +(paineisPorString * vmp_qte).toFixed(1);   // para checagem de segurança

        // ── Verificações normativas ─────────────────────────
        const alertas = [];
        if (voc_total_frio > V_MAX_INV)
            alertas.push(`Voc corrigido (frio, ${T_MIN_CELULA} °C) = ${voc_total_frio} V excede V_máx do inversor (${V_MAX_INV} V). Reduza a string.`);
        if (vmp_total_qte < V_MPPT_MIN)
            alertas.push(`Vmp corrigido (calor, ${T_MAX_CELULA} °C) = ${vmp_total_qte} V está abaixo do MPPT mínimo (${V_MPPT_MIN} V). Aumente a string.`);
        if (vmp_total > V_MPPT_MAX)
            alertas.push(`Vmp nominal (${vmp_total} V) excede o limite MPPT máximo (${V_MPPT_MAX} V). Reduza a string.`);

        return {
            numStrings, paineisPorString,
            voc_total, vmp_total, isc_total, imp_total,
            voc_total_frio, vmp_total_qte,
            voc_painel: voc, vmp_painel: vmp, isc_painel: isc, imp_painel: imp,
            alertas
        };
    }

    // ════════════════════════════════════════════════════════
    //  CABOS DC / AC  (ABNT NBR 16690 §7.4 / NBR 5410 §6.2.7)
    // ════════════════════════════════════════════════════════
    const SECOES_COMERCIAIS = [1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120, 150];

    // Ampacidade NBR 5410 Tab.36 / cabo solar XLPE-EPR H1Z2Z2-K
    // CC  — 2 condutores, instalação em conduto (método B2), 70 °C
    // CA  — 3 condutores, instalação em conduto (método B2), 70 °C
    const AMPACIDADE_DC = [
        {s:1.5, i:20 },{s:2.5, i:27 },{s:4,   i:35 },{s:6,   i:45 },
        {s:10,  i:62 },{s:16,  i:83 },{s:25,  i:109},{s:35,  i:133},
        {s:50,  i:160},{s:70,  i:203},{s:95,  i:248},{s:120, i:289},{s:150,i:330}
    ];
    const AMPACIDADE_AC = [
        {s:1.5, i:13.5},{s:2.5, i:18  },{s:4,   i:24  },{s:6,   i:31  },
        {s:10,  i:43  },{s:16,  i:57  },{s:25,  i:75  },{s:35,  i:92  },
        {s:50,  i:112 },{s:70,  i:138 },{s:95,  i:168 },{s:120, i:194 },{s:150,i:223}
    ];

    // Seção mínima CC para strings FV — norma técnica Energisa GD / NBR 16690 §7.3
    const SECAO_MIN_DC_ENERGISA = 4; // mm²

    function normalizarSecao(secao_calc) {
        const encontrada = SECOES_COMERCIAIS.find(s => s >= secao_calc);
        if (!encontrada) {
            console.warn(`Seção calculada (${secao_calc.toFixed(2)} mm²) excede 150 mm². Verifique o projeto.`);
            return 150;
        }
        return encontrada;
    }

    // Retorna a menor seção comercial cuja ampacidade suporta Ip
    function secaoPorAmpacidade(Ip, tabela) {
        const found = tabela.find(row => row.i >= Ip);
        if (!found) {
            console.warn(`Corrente de projeto ${Ip} A excede a tabela de ampacidade. Adotando 150 mm².`);
            return 150;
        }
        return found.s;
    }

    // Cabo CC por string (de cada string ao inversor ou caixa de combinação)
    // NBR 16690 §7.4: I_proj = Isc × 1,25 × 1,25 = Isc × 1,5625
    // Seção final = max(critério ΔV, critério ampacidade, mínimo Energisa 4 mm²)
    function dimensionarCaboDC(isc_painel, vmp_total, comp = 20) {
        const Ip        = +(isc_painel * 1.5625).toFixed(1);
        const dv_max    = vmp_total * QUEDA_DC_MAX;
        const s_queda   = (2 * RESISTIVIDADE_COBRE * comp * Ip) / dv_max;
        const s_vdrop   = normalizarSecao(s_queda);
        const s_ampa    = secaoPorAmpacidade(Ip, AMPACIDADE_DC);
        const secao_mm2 = Math.max(s_vdrop, s_ampa, SECAO_MIN_DC_ENERGISA);
        const criterio  = (s_ampa > s_vdrop && s_ampa >= SECAO_MIN_DC_ENERGISA) ? 'ampacidade' :
                          (SECAO_MIN_DC_ENERGISA > s_vdrop && SECAO_MIN_DC_ENERGISA >= s_ampa) ? 'min.Energisa' :
                          'queda de tensão';
        const R         = (2 * RESISTIVIDADE_COBRE * comp) / secao_mm2;
        return {
            secao_mm2,
            corrente_projeto: Ip,
            criterio,
            queda_v:   +(R * Ip).toFixed(2),
            queda_pct: +((R * Ip / vmp_total) * 100).toFixed(2)
        };
    }

    // Cabo CA (do inversor ao quadro de distribuição)
    // Seção final = max(critério ΔV, critério ampacidade)
    function dimensionarCaboAC(invKw, tensaoAC = 220, comp = 10) {
        const Iac       = +(invKw * 1000 / tensaoAC).toFixed(1);
        const Ip        = +(Iac * 1.25).toFixed(1);
        const dv_max    = tensaoAC * QUEDA_AC_MAX;
        const s_queda   = (2 * RESISTIVIDADE_COBRE * comp * Ip) / dv_max;
        const s_vdrop   = normalizarSecao(s_queda);
        const s_ampa    = secaoPorAmpacidade(Ip, AMPACIDADE_AC);
        const secao_mm2 = Math.max(s_vdrop, s_ampa);
        const criterio  = s_ampa > s_vdrop ? 'ampacidade' : 'queda de tensão';
        const R         = (2 * RESISTIVIDADE_COBRE * comp) / secao_mm2;
        return {
            secao_mm2,
            corrente_ac:   Iac,
            corrente_proj: Ip,
            criterio,
            queda_v:   +(R * Ip).toFixed(2),
            queda_pct: +((R * Ip / tensaoAC) * 100).toFixed(2)
        };
    }

    // ════════════════════════════════════════════════════════
    //  PROTEÇÕES ELÉTRICAS
    //  Fusível CC: IEC 60269-6 — In ≥ 1,4 × Isc (por string)
    //  DPS CC:     IEC 61643-31 — Uc ≥ 1,2 × Voc_string
    //  Disjuntor CA: NBR 16690 §7.5 — In ≥ 1,25 × Iac
    //  DPS CA:     IEC 61643-11 — Uc ≥ 1,1 × V_rede
    // ════════════════════════════════════════════════════════
    function dimensionarProtecoes(sd, invKw, tensaoAC) {
        const fusivelDC_A = Math.ceil(sd.isc_painel * 1.4 / 5) * 5;      // arredonda para múltiplo de 5 A
        const dps_dc_uc   = Math.ceil(sd.voc_total_frio * 1.2 / 50) * 50;
        const iac         = invKw * 1000 / tensaoAC;
        const djAC_A      = [6,10,16,20,25,32,40,50,63,80,100,125,160]
                              .find(v => v >= iac * 1.25) || 160;
        const dps_ac_uc   = Math.ceil(tensaoAC * 1.1 / 50) * 50;
        return { fusivelDC_A, dps_dc_uc, djAC_A, dps_ac_uc };
    }

    // ════════════════════════════════════════════════════════
    //  ANÁLISE FINANCEIRA — Payback, TIR, VPL (25 anos)
    // ════════════════════════════════════════════════════════
    function analisarFinanceiro(potKwp, geracaoAnual, tarifa = TARIFA_KWH) {
        const investimento = +(potKwp * 1000 * PRECO_WP).toFixed(2);
        let geracaoAtual = geracaoAnual;
        let tarifaAtual  = tarifa;
        let econAcum = 0, vpl = -investimento;
        let paybackS = null, paybackD = null;
        const fluxo = [];

        for (let ano = 1; ano <= 25; ano++) {
            geracaoAtual *= (1 - DEGRADACAO_ANUAL);
            tarifaAtual  *= (1 + REAJUSTE_TARIFA_ANUAL);
            const eco = +(geracaoAtual * tarifaAtual).toFixed(2);
            econAcum += eco;
            const vp  = eco / Math.pow(1 + TMA, ano);
            vpl += vp;
            if (!paybackS && econAcum >= investimento) paybackS = ano;
            if (!paybackD && vpl >= 0)                 paybackD = ano;
            fluxo.push({
                ano,
                geracao:    +geracaoAtual.toFixed(0),
                tarifa:     +tarifaAtual.toFixed(4),
                economia:   eco,
                acumulado:  +econAcum.toFixed(2),
                vpl_acc:    +vpl.toFixed(2)
            });
        }

        return {
            investimento,
            geracaoAnual:   +geracaoAnual.toFixed(0),
            economiaAnual:  fluxo[0].economia,
            economiaTotal:  +econAcum.toFixed(2),
            paybackSimples:    paybackS ?? '> 25',
            paybackDescontado: paybackD ?? '> 25',
            vpl:  +vpl.toFixed(2),
            tir:  calcularTIR(investimento, fluxo.map(f => f.economia)),
            fluxo,
            tarifa
        };
    }

    // Newton-Raphson para TIR — tolerância 1e-7, máx 2000 iterações
    function calcularTIR(inv, receitas) {
        let taxa = 0.10;
        for (let i = 0; i < 2000; i++) {
            let npv = -inv, dnpv = 0;
            receitas.forEach((r, t) => {
                const d = Math.pow(1 + taxa, t + 1);
                npv  += r / d;
                dnpv -= (t + 1) * r / (d * (1 + taxa));
            });
            if (Math.abs(dnpv) < 1e-12) break;  // derivada nula — evitar divisão por zero
            const nova = taxa - npv / dnpv;
            if (Math.abs(nova - taxa) < 1e-7) return +(nova * 100).toFixed(2);
            taxa = nova;
            if (taxa <= -1) return null;
        }
        return null;
    }

    // ════════════════════════════════════════════════════════
    //  GERAÇÃO MÊS A MÊS
    //  E_mes = P_kwp × HSP_dia × dias × PR
    // ════════════════════════════════════════════════════════
    function calcularGeracaoMensal(potKwp, pr, hspMensal) {
        return hspMensal.map((hsp, i) => ({
            mes:    MESES[i],
            hsp:    +hsp.toFixed(2),
            geracao: +(potKwp * hsp * DIAS_MES[i] * pr).toFixed(1),
            dias:   DIAS_MES[i]
        }));
    }

    // ════════════════════════════════════════════════════════
    //  CÁLCULO PRINCIPAL
    // ════════════════════════════════════════════════════════
    window.calcular = async () => {
        const btn       = document.querySelector('.calc-btn');
        const cepVal    = document.getElementById('cep').value.replace(/\D/g, '');
        const consumo   = parseFloat(document.getElementById('consumo').value);
        const painelWp  = parseFloat(document.getElementById('painel-wp').value);
        const sistema   = document.getElementById('sistema').value;
        const grupo     = document.getElementById('grupo').value;
        const conexaoVal = document.getElementById('conexao').value;
        const demanda   = parseFloat(document.getElementById('demanda').value) || 0;
        const autonomia = parseInt(document.getElementById('autonomia').value)  || 1;
        const hspManual = parseFloat(document.getElementById('hsp').value)      || 5.0;

        if (!cepVal || cepVal.length < 8)     return showError("Informe um CEP válido (8 dígitos).");
        if (isNaN(consumo) || consumo <= 0)   return showError("Informe o consumo médio mensal em kWh.");
        if (isNaN(painelWp) || painelWp <= 0) return showError("Potência do painel inválida.");

        btn.textContent = "PROCESSANDO...";
        btn.disabled    = true;
        hideError();

        try {
            // 1. GEOCODIFICAÇÃO ─────────────────────────────
            const viaCepRes = await fetch(`https://viacep.com.br/ws/${cepVal}/json/`);
            const endereco  = await viaCepRes.json();
            if (endereco.erro) throw new Error("CEP não encontrado.");

            const geoRes  = await fetch(
                `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(endereco.localidade + ', ' + endereco.uf + ', Brasil')}&limit=1`
            );
            const geoData = await geoRes.json();
            if (!geoData?.length) throw new Error("Não foi possível obter coordenadas para este CEP.");

            const lat = parseFloat(geoData[0].lat);
            const lon = parseFloat(geoData[0].lon);

            // Temperatura média estimada por latitude (tropical → temperado)
            const tempMedia = Math.max(15, 30 - Math.abs(lat) * 0.4);

            // 2. HSP ANUAL + MENSAL ──────────────────────────
            const dadosAtlas = await buscarNoAtlasPorCoordenadas(lat, lon);
            let hspFinal, hspMensal;

            if (dadosAtlas?.hsp > 0) {
                hspFinal  = dadosAtlas.hsp;
                hspMensal = dadosAtlas.hspMensal?.length === 12
                    ? dadosAtlas.hspMensal
                    : gerarHspMensalSimulado(hspFinal, lat);
                document.getElementById('hsp').value = hspFinal.toFixed(2);
            } else {
                hspFinal  = hspManual;
                hspMensal = gerarHspMensalSimulado(hspFinal, lat);
            }

            // 3. TAXA DE DISPONIBILIDADE (Grupo B, on-grid/híbrido)
            //    Monofásico: 30 kWh/mês · Bifásico: 50 kWh/mês · Trifásico: 100 kWh/mês
            const mapaCusto = { '30': 30, '50': 50, '100': 100 };
            const custo_disp = (grupo === 'B' && sistema !== 'offgrid')
                ? (mapaCusto[conexaoVal] || 50)
                : 0;

            // 4. META DE GERAÇÃO (consumo + taxa de disponibilidade)
            const meta_geracao = consumo + custo_disp;

            // 5. PERFORMANCE RATIO DETALHADO ─────────────────
            const { pr, perdas } = calcularPR(sistema, tempMedia);

            // 6. POTÊNCIA — dimensionada pelo MÊS CRÍTICO
            const hspCritico     = Math.min(...hspMensal);
            const mesIdxCritico  = hspMensal.indexOf(hspCritico);
            const diasCritico    = DIAS_MES[mesIdxCritico];
            const pot_kwp        = meta_geracao / (hspCritico * diasCritico * pr);

            const numPaineis = Math.ceil((pot_kwp * 1000) / painelWp);
            const pot_final  = +((numPaineis * painelWp) / 1000).toFixed(3);

            // 7. INVERSOR
            //    ILR (Inverter Loading Ratio) = P_FV / P_inv = 1,15 → P_inv = P_FV / 1,15
            //    Prática comum e aceita pela ANEEL (até 20 % de clipping)
            const ILR          = (sistema !== 'offgrid') ? 1.15 : 1.0;
            const inv_sugerido = +(pot_final / ILR).toFixed(2);
            const tensaoAC     = { '30': 127, '50': 220, '100': 380 }[conexaoVal] || 220;

            // 8. STRING DESIGN ───────────────────────────────
            const stringDesign = calcularStringDesign(numPaineis, painelWp);

            // 9. CABOS ───────────────────────────────────────
            const caboDC = dimensionarCaboDC(stringDesign.isc_painel, stringDesign.vmp_total);
            const caboAC = dimensionarCaboAC(inv_sugerido, tensaoAC);

            // 10. PROTEÇÕES ──────────────────────────────────
            const protecoes = dimensionarProtecoes(stringDesign, inv_sugerido, tensaoAC);

            // 11. BATERIAS (Off-Grid / Híbrido) ──────────────
            //     Tensão do banco selecionada pela potência do sistema (prática padrão):
            //       ≤ 1 500 W → 12 V  |  ≤ 3 000 W → 24 V  |  > 3 000 W → 48 V
            //     C_Ah = (E_dia_Wh × autonomia) / (V_banco × DoD)
            //     DoD = 50 % → fator 0,5 (baterias chumbo-ácido — conservador)
            let bateriaInfo = null;
            if (sistema === 'offgrid' || sistema === 'hibrido') {
                const pot_w      = pot_final * 1000;
                const tensaoBat  = pot_w <= 1500 ? 12 : pot_w <= 3000 ? 24 : 48;
                const E_dia_Wh   = (meta_geracao / 30) * 1000;   // Wh/dia médio
                const ah         = Math.ceil((E_dia_Wh * autonomia) / (tensaoBat * 0.5));
                const corrente_op = +(pot_w / tensaoBat).toFixed(1);
                bateriaInfo = {
                    tensao:      tensaoBat,
                    corrente_op,
                    ah,
                    controlador: Math.ceil(corrente_op * 1.1),
                    autonomia,
                    e_dia_wh:    +E_dia_Wh.toFixed(0)
                };
            }

            // 12. GERAÇÃO MÊS A MÊS ──────────────────────────
            const geracaoMensal = calcularGeracaoMensal(pot_final, pr, hspMensal);
            const geracaoAnual  = geracaoMensal.reduce((s, m) => s + m.geracao, 0);

            // 13. ANÁLISE FINANCEIRA ──────────────────────────
            const financeiro = analisarFinanceiro(pot_final, geracaoAnual);

            // 14. PRODIST / ANEEL (Grupo A) ───────────────────
            let alertaPRODIST = null;
            if (grupo === 'A' && demanda > 0 && pot_final > demanda) {
                alertaPRODIST =
                    `Potência instalada (${pot_final.toFixed(2)} kWp) excede a demanda contratada ` +
                    `(${demanda} kW). Conforme PRODIST Módulo 3, revise a demanda ou reduza o sistema.`;
            }

            ultimoResultado = {
                cep: cepVal, cidade: `${endereco.localidade}-${endereco.uf}`,
                hsp: hspFinal, hspMensal, hspCritico, mesCritico: MESES[mesIdxCritico],
                diasCritico, consumo, custo_disp, meta_geracao, pr, perdas, tempMedia,
                numPaineis, pot_final, area: +((numPaineis * 2.2)).toFixed(1),
                inv_sugerido, tensaoAC, stringDesign, caboDC, caboAC,
                protecoes, bateriaInfo, geracaoMensal, geracaoAnual,
                financeiro, alertaPRODIST, lat, lon, grupo, demanda,
                tipo: sistema.toUpperCase()
            };

            exibirResultadosCard(ultimoResultado, painelWp);

        } catch (err) {
            showError(err.message || "Erro inesperado. Verifique os dados.");
        } finally {
            btn.textContent = "Calcular Sistema";
            btn.disabled    = false;
        }
    };

    // ════════════════════════════════════════════════════════
    //  EXIBIÇÃO DOS RESULTADOS
    // ════════════════════════════════════════════════════════
    function exibirResultadosCard(res, painelWp) {
        hideError();
        const card = document.getElementById('result-card');
        card.classList.add('show');

        document.getElementById('r-paineis').innerHTML = `${res.numPaineis} <span>painéis</span>`;
        document.getElementById('r-painel-info').textContent =
            `${painelWp} Wp · Área: ${res.area} m² · ${res.stringDesign.numStrings}S × ${res.stringDesign.paineisPorString}P`;

        document.getElementById('r-potencia').innerHTML = `${res.pot_final.toFixed(2)} <span>kWp</span>`;
        document.getElementById('r-geracao').innerHTML  = `${res.meta_geracao.toFixed(0)} <span>kWh/mês</span>`;
        document.getElementById('r-cobertura').textContent =
            `Inv: ${res.inv_sugerido} kW · PR: ${(res.pr * 100).toFixed(1)}% · ` +
            `HSP crítico (${res.mesCritico}): ${res.hspCritico.toFixed(2)} h/dia`;

        const batBlock = document.getElementById('bateria-block');
        if (res.bateriaInfo) {
            batBlock.style.display = 'block';
            document.getElementById('r-baterias').innerHTML = `${res.bateriaInfo.ah} <span>Ah</span>`;
            document.getElementById('r-bat-info').textContent =
                `Banco ${res.bateriaInfo.tensao} V · I = ${res.bateriaInfo.corrente_op} A · ` +
                `Controlador: ${res.bateriaInfo.controlador} A · Autonomia: ${res.bateriaInfo.autonomia} dia(s)`;
        } else {
            batBlock.style.display = 'none';
        }

        const demandaBlock = document.getElementById('demanda-block');
        if (res.alertaPRODIST) {
            demandaBlock.style.display = 'block';
            document.getElementById('r-demanda').innerHTML =
                `<span style="color:#ff7070">⚠ ${res.alertaPRODIST}</span>`;
        } else {
            demandaBlock.style.display = 'none';
        }

        // Seções extras (cria / atualiza)
        let extras = document.getElementById('secoes-extras');
        if (!extras) {
            extras    = document.createElement('div');
            extras.id = 'secoes-extras';
            card.appendChild(extras);
        }
        extras.innerHTML = buildSecoesExtras(res);

        // Botão PDF
        if (!document.getElementById('btnDownload')) {
            const btnPdf       = document.createElement('button');
            btnPdf.id          = 'btnDownload';
            btnPdf.className   = 'calc-btn';
            btnPdf.style.cssText = 'margin-top:20px;background:#27ae60;';
            btnPdf.textContent = 'BAIXAR RELATÓRIO PDF';
            btnPdf.onclick     = gerarPDF;
            card.appendChild(btnPdf);
        }
    }

    // ════════════════════════════════════════════════════════
    //  HTML DAS SEÇÕES EXTRAS
    // ════════════════════════════════════════════════════════
    function metricaMini(label, valor, cor = 'var(--text)') {
        return `<div style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:0.4rem 0.6rem">
            <div style="font-family:'JetBrains Mono',monospace;font-size:0.58rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.07em">${label}</div>
            <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:0.88rem;color:${cor};margin-top:2px">${valor}</div>
        </div>`;
    }

    function buildSecoesExtras(res) {
        const f = res.financeiro;
        const s = res.stringDesign;
        const p = res.protecoes;

        // PR — barras de perdas
        const nomePerdas = {
            inversor: 'Inversor', cabeamento_dc: 'Cabeamento CC', temperatura: 'Temperatura',
            sombreamento: 'Sombreamento', sujidade: 'Sujidade', mismatch: 'Mismatch',
            disponibilidade: 'Disponibilidade', controlador: 'Controlador', baterias: 'Baterias'
        };
        const perdasHtml = Object.entries(res.perdas).map(([k, v]) => {
            const pct = (v * 100).toFixed(1);
            const bar = Math.min(Math.round(v * 100 * 5), 100);
            return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;font-size:0.73rem;font-family:'JetBrains Mono',monospace">
                <span style="width:108px;color:var(--muted)">${nomePerdas[k] || k}</span>
                <div style="flex:1;background:rgba(255,255,255,0.06);border-radius:3px;height:5px">
                  <div style="width:${bar}%;background:var(--amber);height:5px;border-radius:3px"></div>
                </div>
                <span style="color:var(--amber);width:38px;text-align:right">-${pct}%</span>
            </div>`;
        }).join('');

        // Alertas String Design
        const alertasHtml = s.alertas.length
            ? s.alertas.map(a => `<div class="note-item" style="color:#ff7070;margin-top:4px">⚠ ${a}</div>`).join('')
            : `<div class="note-item" style="color:var(--teal);margin-top:4px">✓ Configuração dentro dos limites normativos (MPPT + Voc corrigido por temperatura)</div>`;

        // Gráfico de geração mensal
        const maxG = Math.max(...res.geracaoMensal.map(m => m.geracao));
        const geracaoHtml = res.geracaoMensal.map(m => {
            const h   = Math.max(4, Math.round((m.geracao / maxG) * 60));
            const cor = m.geracao < res.meta_geracao * 0.9 ? 'var(--amber)' : 'var(--teal)';
            return `<div style="display:flex;flex-direction:column;align-items:center;gap:3px;flex:1;min-width:0">
                <span style="font-size:0.55rem;color:var(--muted);font-family:'JetBrains Mono',monospace">${m.geracao}</span>
                <div style="width:100%;background:${cor};border-radius:3px 3px 0 0;height:${h}px"></div>
                <span style="font-size:0.58rem;color:var(--muted);font-family:'JetBrains Mono',monospace">${m.mes}</span>
            </div>`;
        }).join('');

        const vplCor = f.vpl >= 0 ? 'var(--teal)' : '#ff7070';
        const tirStr = f.tir !== null ? `${f.tir}% a.a.` : `> ${(TMA * 100).toFixed(0)}%`;

        return `
        <!-- PERFORMANCE RATIO -->
        <div class="metric" style="border-top:1px solid var(--border);padding-top:1.2rem;margin-top:0.4rem">
          <div class="metric-label">Performance Ratio — perdas por componente (IEC 61724-1)</div>
          <div class="metric-value" style="font-size:1.2rem;color:var(--teal);margin-bottom:0.8rem">
            ${(res.pr * 100).toFixed(1)}% <span>PR</span>
          </div>
          ${perdasHtml}
        </div>

        <!-- STRING DESIGN -->
        <div class="metric">
          <div class="metric-label">String Design — configuração elétrica CC (NBR 16690 / IEC 62109)</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.45rem;margin-top:0.6rem">
            ${metricaMini('Strings (paralelo)', s.numStrings)}
            ${metricaMini('Painéis/String (série)', s.paineisPorString)}
            ${metricaMini('Voc nominal (STC)', s.voc_total + ' V')}
            ${metricaMini('Voc corrigido (5 °C)', s.voc_total_frio + ' V')}
            ${metricaMini('Vmp nominal (STC)', s.vmp_total + ' V')}
            ${metricaMini('Vmp corrigido (70 °C)', s.vmp_total_qte + ' V')}
            ${metricaMini('Isc total', s.isc_total + ' A')}
            ${metricaMini('Imp total', s.imp_total + ' A')}
          </div>
          ${alertasHtml}
        </div>

        <!-- CABOS E PROTEÇÕES -->
        <div class="metric">
          <div class="metric-label">Cabos e Proteções — NBR 16690 · NBR 5410 · IEC 61643</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.45rem;margin-top:0.6rem">
            ${metricaMini('Cabo CC (string → inv.)', res.caboDC.secao_mm2 + ' mm²')}
            ${metricaMini('I projeto CC (Isc×1,5625)', res.caboDC.corrente_projeto + ' A')}
            ${metricaMini('ΔV CC (máx. 3%)', res.caboDC.queda_v + ' V (' + res.caboDC.queda_pct + '%)')}
            ${metricaMini('Cabo CA (inv. → QD)', res.caboAC.secao_mm2 + ' mm²')}
            ${metricaMini('I projeto CA (Iac×1,25)', res.caboAC.corrente_proj + ' A')}
            ${metricaMini('ΔV CA (máx. 2%)', res.caboAC.queda_v + ' V (' + res.caboAC.queda_pct + '%)')}
            ${metricaMini('Fusível CC/string (≥1,4×Isc)', p.fusivelDC_A + ' A')}
            ${metricaMini('DPS CC Uc mín (≥1,2×Voc_frio)', p.dps_dc_uc + ' V')}
            ${metricaMini('Disjuntor CA (≥1,25×Iac)', p.djAC_A + ' A')}
            ${metricaMini('DPS CA Uc mín (≥1,1×Vrede)', p.dps_ac_uc + ' V')}
          </div>
        </div>

        <!-- GERAÇÃO MÊS A MÊS -->
        <div class="metric">
          <div class="metric-label">Geração estimada — mês a mês (kWh)</div>
          <div style="display:flex;align-items:flex-end;gap:3px;height:80px;margin-top:0.9rem">
            ${geracaoHtml}
          </div>
          <div style="margin-top:0.5rem;font-size:0.68rem;color:var(--muted);font-family:'JetBrains Mono',monospace">
            Amarelo = mês abaixo de 90% da meta · Mês crítico: ${res.mesCritico} (${res.hspCritico.toFixed(2)} h/dia, ${res.diasCritico} dias) · Total anual: ${res.geracaoAnual.toFixed(0)} kWh
          </div>
        </div>

        <!-- ANÁLISE FINANCEIRA -->
        <div class="metric">
          <div class="metric-label">Análise financeira — 25 anos de vida útil</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.45rem;margin-top:0.6rem">
            ${metricaMini('Investimento', 'R$\u00a0' + f.investimento.toLocaleString('pt-BR', { minimumFractionDigits: 2 }))}
            ${metricaMini('Economia Ano 1', 'R$\u00a0' + f.economiaAnual.toLocaleString('pt-BR', { minimumFractionDigits: 2 }))}
            ${metricaMini('Payback simples', f.paybackSimples + ' anos')}
            ${metricaMini('Payback desc. (TMA ' + Math.round(TMA * 100) + '%)', f.paybackDescontado + ' anos')}
            ${metricaMini('TIR', tirStr, 'var(--teal)')}
            ${metricaMini('VPL (25 anos)', 'R$\u00a0' + f.vpl.toLocaleString('pt-BR', { minimumFractionDigits: 2 }), vplCor)}
            ${metricaMini('Economia total', 'R$\u00a0' + f.economiaTotal.toLocaleString('pt-BR', { minimumFractionDigits: 2 }))}
            ${metricaMini('Tarifa base', 'R$\u00a0' + TARIFA_KWH + '/kWh')}
          </div>
          <div style="margin-top:0.5rem;font-size:0.68rem;color:var(--muted);font-family:'JetBrains Mono',monospace">
            Reajuste tarifário: ${(REAJUSTE_TARIFA_ANUAL * 100).toFixed(0)}%/ano · Degradação painel: ${(DEGRADACAO_ANUAL * 100).toFixed(1)}%/ano · R$${PRECO_WP}/Wp instalado · ILR = ${(1.15).toFixed(2)}
          </div>
        </div>`;
    }

    // ════════════════════════════════════════════════════════
    //  PDF — MEMORIAL DE CÁLCULO (ABNT NBR 16690)
    // ════════════════════════════════════════════════════════
    function gerarPDF() {
        const jsPDF = (window.jspdf || window).jsPDF;
        if (!jsPDF)           { alert("Erro: jsPDF não carregada."); return; }
        if (!ultimoResultado) { alert("Calcule o sistema antes de gerar o PDF."); return; }

        const doc      = new jsPDF({ unit: 'mm', format: 'a4' });
        const res      = ultimoResultado;
        const f        = res.financeiro;
        const s        = res.stringDesign;
        const p        = res.protecoes;
        const painelWp = parseFloat(document.getElementById('painel-wp').value);

        const PL = 14, PR_END = 196, PW = PR_END - PL;
        let y = 20;

        // helpers ──────────────────────────────────────────
        const checkY = (n = 28) => { if (y + n > 272) addPage(); };

        const addPage = () => {
            rodape(doc, res);
            doc.addPage();
            doc.setFillColor(7, 8, 12);
            doc.rect(0, 0, 210, 297, 'F');
            doc.setTextColor(220, 220, 220);
            y = 20;
        };

        const titulo = (txt, num = '') => {
            checkY(14);
            doc.setFillColor(13, 15, 22);
            doc.rect(PL, y - 4, PW, 9, 'F');
            doc.setFont("helvetica", "bold");
            doc.setFontSize(7.5);
            doc.setTextColor(0, 217, 164);
            doc.text((num ? num + '. ' : '') + txt.toUpperCase(), PL + 2, y + 2);
            doc.setTextColor(220, 220, 220);
            y += 11;
        };

        const linha = (lbl, val, destaque = false) => {
            checkY(7);
            doc.setFont("courier", destaque ? "bold" : "normal");
            doc.setFontSize(7.8);
            doc.setTextColor(130, 140, 160);
            doc.text(lbl, PL, y);
            doc.setTextColor(destaque ? 245 : 215, destaque ? 197 : 215, destaque ? 71 : 215);
            doc.text(String(val), PL + 97, y);
            y += 6.5;
        };

        const sep = () => {
            checkY(5);
            doc.setDrawColor(25, 30, 45);
            doc.line(PL, y, PR_END, y);
            y += 4;
        };

        // ── CAPA ─────────────────────────────────────────────
        doc.setFillColor(7, 8, 12);
        doc.rect(0, 0, 210, 297, 'F');
        doc.setFillColor(0, 217, 164);
        doc.rect(0, 100, 210, 1, 'F');
        doc.rect(0, 102, 210, 0.3, 'F');
        doc.setFont("helvetica", "bold");
        doc.setFontSize(26);
        doc.setTextColor(255, 255, 255);
        doc.text("MEMORIAL DE", 105, 72, { align: 'center' });
        doc.setTextColor(0, 217, 164);
        doc.text("CÁLCULO SOLAR", 105, 84, { align: 'center' });
        doc.setFont("helvetica", "normal");
        doc.setFontSize(10);
        doc.setTextColor(160, 170, 190);
        doc.text(`Sistema ${res.tipo}  ·  ${res.cidade}`, 105, 112, { align: 'center' });
        doc.text(`CEP ${res.cep}  ·  ${parseFloat(res.lat).toFixed(4)}°, ${parseFloat(res.lon).toFixed(4)}°`, 105, 120, { align: 'center' });

        const badges = [
            `${res.pot_final.toFixed(2)} kWp`,
            `${res.numPaineis} painéis`,
            `${res.geracaoAnual.toFixed(0)} kWh/ano`,
            `TIR ${f.tir !== null ? f.tir + '%' : '>8%'}`
        ];
        badges.forEach((b, i) => {
            const bx = 20 + i * 44;
            doc.setFillColor(13, 15, 22);
            doc.roundedRect(bx, 135, 40, 16, 2, 2, 'F');
            doc.setFont("helvetica", "bold");
            doc.setFontSize(9);
            doc.setTextColor(0, 217, 164);
            doc.text(b, bx + 20, 145, { align: 'center' });
        });

        doc.setFont("courier", "normal");
        doc.setFontSize(7);
        doc.setTextColor(60, 70, 90);
        doc.text("Elaborado por: Kessia Carvalho  ·  Dimensionamento Fotovoltaico v3.1", 105, 275, { align: 'center' });
        doc.text(`Emitido em: ${new Date().toLocaleDateString('pt-BR')}  ·  Estimativa técnica. Projeto definitivo requer ART de engenheiro credenciado no CREA.`, 105, 281, { align: 'center' });

        // ── PÁG 2 — Dados e Parâmetros ─────────────────────
        addPage();
        titulo("Dados do Projeto", "1");
        linha("Localização (CEP)", res.cep);
        linha("Cidade / UF", res.cidade);
        linha("Latitude / Longitude", `${parseFloat(res.lat).toFixed(4)}° / ${parseFloat(res.lon).toFixed(4)}°`);
        linha("Tipo de Sistema", res.tipo);
        linha("Grupo Tarifário / Conexão", `${res.grupo} / ${res.tensaoAC} V`);
        if (res.grupo === 'A') linha("Demanda Contratada", `${res.demanda} kW`);
        sep();

        titulo("Parâmetros de Cálculo", "2");
        linha("Consumo base informado", `${res.consumo} kWh/mês`);
        if (res.custo_disp > 0) linha("Taxa de Disponibilidade (Grupo B)", `${res.custo_disp} kWh/mês`);
        linha("Meta de Geração Total", `${res.meta_geracao.toFixed(2)} kWh/mês`, true);
        linha("HSP médio anual (Atlas LABREN / manual)", `${res.hsp.toFixed(3)} kWh/m².dia`);
        linha("Mês crítico (dimensionamento conservador)", `${res.mesCritico} — ${res.diasCritico} dias`);
        linha("HSP mês crítico", `${res.hspCritico.toFixed(3)} kWh/m².dia`, true);
        linha("Temperatura média estimada (local)", `${res.tempMedia.toFixed(1)} °C`);
        sep();

        titulo("Performance Ratio Detalhado — IEC 61724-1", "3");
        const nomePerdas = {
            inversor: 'Inversor', cabeamento_dc: 'Cabeamento CC',
            temperatura: 'Temperatura (NOCT)', sombreamento: 'Sombreamento',
            sujidade: 'Sujidade', mismatch: 'Mismatch',
            disponibilidade: 'Disponibilidade', controlador: 'Controlador CC',
            baterias: 'Banco de Baterias'
        };
        Object.entries(res.perdas).forEach(([k, v]) => {
            linha(`  Perda — ${nomePerdas[k] || k}`, `-${(v * 100).toFixed(1)}%`);
        });
        linha("Performance Ratio (PR) resultante", `${(res.pr * 100).toFixed(1)}%`, true);
        sep();

        // ── PÁG 3 — Dimensionamento ─────────────────────────
        addPage();
        titulo("Dimensionamento dos Equipamentos", "4");
        linha("Painel fotovoltaico selecionado", `${painelWp} Wp`);
        linha("Quantidade de painéis", `${res.numPaineis} unidades`);
        linha("Potência total instalada", `${res.pot_final.toFixed(3)} kWp`, true);
        linha("Área de telhado estimada (~2,2 m²/painel)", `${res.area} m²`);
        linha("ILR — Inverter Loading Ratio", "1,15 (15% clipping — prática ANEEL)");
        linha("Inversor recomendado (P_FV / ILR)", `${res.inv_sugerido} kW`);
        sep();

        titulo("String Design — NBR 16690 §6 / IEC 62109-2 §4", "5");
        linha("Strings em paralelo", `${s.numStrings}`);
        linha("Painéis por string (série)", `${s.paineisPorString}`);
        linha("Voc por painel (STC)", `${s.voc_painel} V`);
        linha("Voc total nominal (STC)", `${s.voc_total} V`);
        linha("Voc total corrigido (T_min = 5 °C)", `${s.voc_total_frio} V  ← verificado contra V_MAX_INV`);
        linha("Vmp total nominal (STC)", `${s.vmp_total} V`);
        linha("Vmp total corrigido (T_cell = 70 °C)", `${s.vmp_total_qte} V  ← verificado contra MPPT_MIN`);
        linha("Isc total (todas as strings)", `${s.isc_total} A`);
        linha("Imp total", `${s.imp_total} A`);
        if (s.alertas.length) {
            s.alertas.forEach(a => linha("⚠ ALERTA", a));
        } else {
            linha("Verificação normativa", "Dentro dos limites (Voc_frio / Vmp_qte / MPPT)");
        }
        sep();

        titulo("Dimensionamento de Cabos — NBR 16690 §7 / NBR 5410", "6");
        linha("Seção cabo CC (string → inversor)", `${res.caboDC.secao_mm2} mm²`);
        linha("Corrente de projeto CC (Isc × 1,25 × 1,25)", `${res.caboDC.corrente_projeto} A`);
        linha("Queda de tensão CC (máx. 3%)", `${res.caboDC.queda_v} V  (${res.caboDC.queda_pct}%)`);
        linha("Seção cabo CA (inversor → QD)", `${res.caboAC.secao_mm2} mm²`);
        linha("Corrente de projeto CA (Iac × 1,25)", `${res.caboAC.corrente_proj} A`);
        linha("Queda de tensão CA (máx. 2%)", `${res.caboAC.queda_v} V  (${res.caboAC.queda_pct}%)`);
        sep();

        titulo("Proteções Elétricas — NBR 16690 / IEC 60269-6 / IEC 61643", "7");
        linha("Fusível CC por string  (In ≥ 1,4 × Isc_painel)", `${p.fusivelDC_A} A`);
        linha("DPS CC Classe II  (Uc ≥ 1,2 × Voc_frio_string)", `Uc ≥ ${p.dps_dc_uc} V`);
        linha("Disjuntor CA  (In ≥ 1,25 × Iac)", `${p.djAC_A} A`);
        linha("DPS CA Classe II  (Uc ≥ 1,1 × V_rede)", `Uc ≥ ${p.dps_ac_uc} V`);
        sep();

        if (res.bateriaInfo) {
            titulo("Sistema de Armazenamento (DoD 50%)", "8");
            linha("Tensão do banco (seleção automática)", `${res.bateriaInfo.tensao} V`);
            linha("Corrente de operação  I = P / V_banco", `${res.bateriaInfo.corrente_op} A`);
            linha("Capacidade  C = (E_dia × aut.) / (V × DoD)", `${res.bateriaInfo.ah} Ah`);
            linha("Controlador de carga  (1,1 × I_op)", `${res.bateriaInfo.controlador} A`);
            linha("Autonomia desejada", `${res.bateriaInfo.autonomia} dia(s)`);
            sep();
        }

        // ── PÁG 4 — Geração e Financeiro ─────────────────────
        addPage();
        titulo("Geração Estimada Mês a Mês — E = P × HSP × dias × PR", "9");
        res.geracaoMensal.forEach((m, i) => {
            const flag = m.geracao < res.meta_geracao * 0.9;
            linha(
                `  ${m.mes}  (${DIAS_MES[i]} dias · HSP ${m.hsp} h/dia)`,
                `${m.geracao} kWh${flag ? '  ⚠ abaixo de 90% da meta' : ''}`,
                flag
            );
        });
        linha("TOTAL ANUAL", `${res.geracaoAnual.toFixed(0)} kWh`, true);
        sep();

        titulo("Análise Financeira — 25 Anos de Vida Útil", "10");
        linha("Investimento estimado  (R$" + PRECO_WP + "/Wp instalado)", `R$ ${f.investimento.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
        linha("Economia estimada no Ano 1", `R$ ${f.economiaAnual.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
        linha("Economia total em 25 anos", `R$ ${f.economiaTotal.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
        linha("Payback Simples", `${f.paybackSimples} anos`);
        linha(`Payback Descontado  (TMA ${(TMA * 100).toFixed(0)}% a.a.)`, `${f.paybackDescontado} anos`);
        linha("TIR — Taxa Interna de Retorno (25 anos)", f.tir !== null ? `${f.tir}% a.a.` : `> ${(TMA * 100).toFixed(0)}%`, true);
        linha("VPL — Valor Presente Líquido (25 anos)", `R$ ${f.vpl.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`, f.vpl >= 0);
        linha("Tarifa base utilizada", `R$ ${TARIFA_KWH}/kWh`);
        linha("Reajuste tarifário estimado", `${(REAJUSTE_TARIFA_ANUAL * 100).toFixed(0)}% a.a.`);
        linha("Degradação anual dos painéis", `${(DEGRADACAO_ANUAL * 100).toFixed(1)}% a.a.`);
        sep();

        if (res.alertaPRODIST) {
            titulo("Verificação PRODIST / ANEEL", "11");
            checkY(14);
            doc.setFont("courier", "bold");
            doc.setFontSize(7.8);
            doc.setTextColor(255, 112, 112);
            doc.text("⚠ " + res.alertaPRODIST, PL, y, { maxWidth: PW });
            y += 14;
            doc.setTextColor(220, 220, 220);
            sep();
        }

        titulo("Normas e Observações Técnicas");
        const obs = [
            "ABNT NBR 16690:2019  —  Instalações elétricas de sistemas fotovoltaicos (requisitos mínimos)",
            "ABNT NBR 5410         —  Instalações elétricas de baixa tensão (cabo CA / disjuntor)",
            "PRODIST Módulo 3      —  Acesso ao sistema de distribuição (ANEEL)",
            "IEC 61643-31          —  Proteção contra sobretensões CC (DPS, Uc ≥ 1,2 × Voc_frio)",
            "IEC 61643-11          —  Proteção contra sobretensões CA (DPS, Uc ≥ 1,1 × Vrede)",
            "IEC 60269-6           —  Fusíveis CC para sistemas FV (In ≥ 1,4 × Isc)",
            "IEC 62109-2 §4.3.8    —  Verificação de tensão por temperatura (string design)",
            "IEC 61724-1           —  Performance ratio — decomposição de perdas por componente",
            "IEC 61215             —  Qualificação de projeto de módulos FV",
            "Atlas LABREN/INPE     —  Base de dados de irradiação solar (Brasil)",
            "Dimensionamento pelo mês crítico (HSP mínimo anual) — critério conservador.",
            "String design: Voc verificado a T_min = 5 °C; Vmp verificado a T_cell = 70 °C.",
            "Valores são estimativas. Projeto definitivo requer ART de Engenheiro credenciado no CREA.",
        ];
        obs.forEach(o => {
            checkY(7);
            doc.setFont("courier", "normal");
            doc.setFontSize(7);
            doc.setTextColor(90, 100, 120);
            doc.text(o, PL, y);
            y += 6;
        });

        rodape(doc, res);
        doc.save(`Memorial_Calculo_Solar_${res.cep}_${new Date().toISOString().slice(0, 10)}.pdf`);
    }

    function rodape(doc, res) {
        doc.setFont("courier", "normal");
        doc.setFontSize(6.5);
        doc.setTextColor(50, 60, 80);
        doc.text(`Memorial de Cálculo Fotovoltaico  ·  ${res.cidade}  ·  CEP ${res.cep}`, 14, 291);
        doc.text(`Gerado em ${new Date().toLocaleString('pt-BR')}`, 196, 291, { align: 'right' });
    }
});

// ── Detecção touch ──
const isTouch = () => window.matchMedia('(hover:none) and (pointer:coarse)').matches;

// ── Cursor (só desktop) ──
if (!isTouch()) {
  const dot = document.querySelector('.cursor-dot');
  const out = document.querySelector('.cursor-outline');
  if (dot && out) {
    let mx=0,my=0,ox=0,oy=0;
    window.addEventListener('mousemove', e => {
      mx=e.clientX; my=e.clientY;
      dot.style.transform=`translate(${mx}px,${my}px) translate(-50%,-50%)`;
    });
    (function loop(){
      ox+=(mx-ox)*.15; oy+=(my-oy)*.15;
      out.style.transform=`translate(${ox}px,${oy}px) translate(-50%,-50%)`;
      requestAnimationFrame(loop);
    })();
    document.querySelectorAll('a,button,.project-card,.contact-item').forEach(el=>{
      el.addEventListener('mouseenter',()=>{out.style.width='55px';out.style.height='55px';out.style.backgroundColor='var(--teal-dim)';out.style.opacity='.2'});
      el.addEventListener('mouseleave',()=>{out.style.width='34px';out.style.height='34px';out.style.backgroundColor='transparent';out.style.opacity='.4'});
    });
  }
}