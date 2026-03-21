document.addEventListener('DOMContentLoaded', () => {
    const checkbox = document.querySelector('#checkbox');
    const menuBtn = document.getElementById('openIcon');
    const closeBtn = document.getElementById('closeIcon');
    const menuOverlay = document.getElementById('menuOverlay');
    const tipoSys = document.getElementById('tipo_sys');
    const grupo = document.getElementById('grupo');
    const solarForm = document.getElementById('solarForm');

    let ultimoResultado = null;

    // --- INTERFACE MENU E TEMA ---
    const openMenu = () => {
        menuOverlay.classList.remove('hidden');
        menuBtn.classList.add('hidden');
        closeBtn.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    };

    const closeMenu = () => {
        menuOverlay.classList.add('hidden');
        menuBtn.classList.remove('hidden');
        closeBtn.classList.add('hidden');
        document.body.style.overflow = 'auto';
    };

    // 1. FECHAR AO CLICAR NO OVERLAY (FORA DO MENU)
    menuOverlay.addEventListener('click', (e) => {
        if (e.target === menuOverlay) {
            closeMenu();
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === "Escape" && !menuOverlay.classList.contains('hidden')) {
            closeMenu();
        }
    });

    if (menuBtn) menuBtn.addEventListener('click', openMenu);
    if (closeBtn) closeBtn.addEventListener('click', closeMenu);
    if (checkbox) {
        checkbox.addEventListener('change', () => {
            document.body.classList.toggle('light-mode');
        });
    }

    // --- LOGICA DE EXIBICAO DE CAMPOS ---
    const atualizarCampos = () => {
        const tipoVal = document.getElementById('tipo_sys').value;
        const grupoVal = document.getElementById('grupo').value;
        
        const divGrupo = document.getElementById('container_grupo');
        const divPadrao = document.getElementById('campo_padrao');
        const divDemanda = document.getElementById('campo_demanda');
        const divAutonomia = document.getElementById('campo_autonomia');

        if (tipoVal === 'offgrid') {
            // OFF-GRID: Esconde tudo da rede e mostra apenas autonomia
            divGrupo.style.display = 'none';
            divPadrao.style.display = 'none';
            divDemanda.style.display = 'none';
            divAutonomia.style.display = 'block';
        } else {
            // ON-GRID ou HÍBRIDO: Mostra seletor de grupo e lógica normal
            divGrupo.style.display = 'block';
            divAutonomia.style.display = (tipoVal === 'hibrido') ? 'block' : 'none';
            
            if (grupoVal === 'B') {
                divPadrao.style.display = 'block';
                divDemanda.style.display = 'none';
            } else {
                divPadrao.style.display = 'none';
                divDemanda.style.display = 'block';
            }
        }
    };

    if (tipoSys) tipoSys.addEventListener('change', atualizarCampos);
    if (grupo) grupo.addEventListener('change', atualizarCampos);

    atualizarCampos();

    // --- BUSCA NO ATLAS LABREN ---
    async function buscarNoAtlasPorCoordenadas(latBusca, lonBusca) {
        try {
            const response = await fetch('./atlas_labren.csv');
            if (!response.ok) throw new Error("Arquivo atlas_labren.csv não encontrado.");
            const data = await response.text();
            const linhas = data.split(/\r?\n/);
            let melhorPonto = null;
            let menorDistancia = Infinity;
            const latAlvo = parseFloat(latBusca);
            const lonAlvo = parseFloat(lonBusca);

            for (let i = 1; i < linhas.length; i++) {
                if (!linhas[i].trim()) continue;
                const colunas = linhas[i].split(';');
                if (colunas.length < 5) continue;
                const lonCsv = parseFloat(colunas[2]);
                const latCsv = parseFloat(colunas[3]);
                const distancia = Math.sqrt(Math.pow(latAlvo - latCsv, 2) + Math.pow(lonAlvo - lonCsv, 2));

                if (distancia < menorDistancia) {
                    menorDistancia = distancia;
                    melhorPonto = {
                        lat: colunas[3].trim(),
                        lon: colunas[2].trim(),
                        hsp: parseFloat(colunas[4]) / 1000
                    };
                }
            }
            return (menorDistancia < 0.5) ? melhorPonto : null;
        } catch (error) { throw error; }
    }

    // --- LOGICA DE CALCULO ---
    if (solarForm) {
        solarForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = document.getElementById('btnCalcular');
            btn.innerHTML = "PROCESSANDO...";
            btn.disabled = true;

            try {
                const formData = new FormData(solarForm);
                const cepInput = formData.get('cep').replace(/\D/g, '');

                const viaCepRes = await fetch(`https://viacep.com.br/ws/${cepInput}/json/`);
                const endereco = await viaCepRes.json();
                if (endereco.erro) throw new Error("CEP não encontrado.");

                const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(endereco.localidade + ',' + endereco.uf)}&limit=1`);
                const geoData = await geoRes.json();
                const latEncontrada = geoData[0].lat;
                const lonEncontrada = geoData[0].lon;

                const dadosAtlas = await buscarNoAtlasPorCoordenadas(latEncontrada, lonEncontrada);
                if (!dadosAtlas) throw new Error("Coordenadas fora da cobertura do Atlas.");

                // --- VARIAVEIS ---
                const hsp = dadosAtlas.hsp;
                const consumo = parseFloat(formData.get('media_kwh')) || 0;
                const tipo = formData.get('tipo_sys');
                const grupoVal = formData.get('grupo');
                const padrao = formData.get('padrao') || 'mono';
                const demanda = parseFloat(formData.get('demanda')) || 0;
                const autonomia = parseInt(formData.get('autonomia')) || 0;

                // Calculo Meta de Geração (Grupo B)
                let custo_disp = (tipo !== 'offgrid' && grupoVal === 'B') ? 
                                 { 'mono': 30, 'bi': 50, 'tri': 100 }[padrao] : 0;

                const meta_geracao = consumo + custo_disp;
                const eff = { 'ongrid': 0.80, 'offgrid': 0.65, 'hibrido': 0.75 }[tipo];
                
                const pot_kwp = meta_geracao / (hsp * 30 * eff);
                const paineis = Math.ceil((pot_kwp * 1000) / 430);
                const pot_final = (paineis * 430) / 1000;

                // Logica de Baterias (Offgrid/Híbrido)
                let bateriaInfo = null;
                if (tipo !== 'ongrid') {
                    const tensao = pot_final <= 2.0 ? 12 : pot_final <= 4.0 ? 24 : 48;
                    const ah = Math.ceil(((meta_geracao/30)*1000*autonomia)/(tensao*0.5));
                    const controlador = Math.ceil(((pot_final*1000)/tensao)*1.1);
                    bateriaInfo = { tensao, ah, controlador, autonomia };
                }

                ultimoResultado = { 
                    cep: formData.get('cep'),
                    cidade: `${endereco.localidade} - ${endereco.uf}`,
                    hsp: hsp,
                    consumo: consumo,
                    custo_disp: custo_disp,
                    meta_geracao: meta_geracao,
                    paineis: paineis,
                    pot_final: pot_final,
                    area: (paineis * 2.2).toFixed(1),
                    inv_sugerido: (pot_final / (tipo === 'offgrid' ? 1.0 : 1.15)).toFixed(1),
                    lat: dadosAtlas.lat,
                    lon: dadosAtlas.lon,
                    grupo: grupoVal,
                    demanda: demanda,
                    bateriaInfo: bateriaInfo,
                    tipo: tipo.toUpperCase()
                };

                exibirResultado(ultimoResultado);

            } catch (err) {
                alert("Erro: " + err.message);
            } finally {
                btn.innerHTML = "CALCULAR";
                btn.disabled = false;
            }
        });
    }

    function exibirResultado(res) {
        const container = document.getElementById('resultado-container');
        const formData = new FormData(document.getElementById('solarForm'));

        const sistema = res.tipo;
        
        // --- CONSTRUCAO DO RELATÓRIO ---
        let blocoEntradaExtra = "";
        let blocoProjetoExtra = "";
        let alertaTXT = "";

        if (sistema === 'OFFGRID') {
            blocoEntradaExtra = `Consumo Medio Mensal (kWh): ${res.consumo}\nAutonomia Desejada: ${res.bateriaInfo.autonomia} Dias`;
            blocoProjetoExtra = `Tipo de Conexao: ISOLADO (Sem Rede)`;
        } else {
            const grupo = formData.get('grupo').toUpperCase();
            const padrao = (res.grupo === 'B') ? formData.get('padrao').toUpperCase() : 'N/A';
            
            blocoEntradaExtra = `Grupo Tarifario [A / B]: ${grupo}
            Consumo Medio Mensal (kWh): ${res.consumo}
             ${res.grupo === 'B' ? `Padrao Energisa [mono / bi / tri]: ${padrao}` : `Demanda Contratada (kW): ${res.demanda}`}`;
            
            blocoProjetoExtra = `Grupo Tarifario: ${grupo}`;

            // Alerta de Demanda apenas para sistemas com rede (Grupo A)
            if (res.grupo === 'A' && res.pot_final > res.demanda) {
                alertaTXT = `\n[!] ALERTA: Potencia (${res.pot_final.toFixed(1)}kWp) excede a Demanda (${res.demanda}kW)!\n`;
            }
        }

        // Bloco de Baterias
        let batTXT = "";
        if (res.bateriaInfo) {
            batTXT = `-------------------------------------------------------
    SISTEMA DE ARMAZENAMENTO:
    Tensao do Banco: ${res.bateriaInfo.tensao}V
    Capacidade do Banco: ${res.bateriaInfo.ah} Ah
    Controlador de Carga: ${res.bateriaInfo.controlador} A
    Autonomia: ${res.bateriaInfo.autonomia} Dias\n`;
        }

        container.innerHTML = `
        <div class="resultado-tecnico" style="margin-top:20px; background: rgba(130, 87, 230, 0.1); padding: 15px; border-radius: 8px; border-left: 5px solid #8257E6; color: inherit;">
            <pre style="white-space: pre-wrap; font-family: monospace; font-size: 13px; line-height: 1.4;">
    ============================================================
        SISTEMA DE DIMENSIONAMENTO SOLAR
    ============================================================
    CEP da Instalacao: ${res.cep}
    Sistema [ongrid / offgrid / hibrido]: ${sistema}
    ${blocoEntradaExtra}

    *******************************************************
    DADOS DO PROJETO
    Localizacao (CEP): ${res.cep}
    Latitude: ${parseFloat(res.lat).toFixed(4)} | Longitude: ${parseFloat(res.lon).toFixed(4)}
    Tipo de Sistema: ${sistema}
    ${blocoProjetoExtra}
    -------------------------------------------------------
    PARAMETROS TECNICOS:
    HSP Local (CRESESB): ${res.hsp.toFixed(2)} kWh/m2.dia
    Consumo Base: ${res.consumo.toFixed(1)} kWh
    Taxa Disponibilidade (Consessinária): ${res.custo_disp} kWh
    Meta de Geracao Total: ${res.meta_geracao.toFixed(2)} kWh/mes
    -------------------------------------------------------
    DIMENSIONAMENTO DOS EQUIPAMENTOS:
    Paineis (430W): ${res.paineis} Unidades
    Potencia Total Instalada: ${res.pot_final.toFixed(2)} kWp
    Area de Telhado Estimada: ${res.area} m2
    Inversor Recomendado: ${res.inv_sugerido} kW
    ${alertaTXT}${batTXT}-------------------------------------------------------
    OBS: Verifique a estrutura mecanica do telhado.
    *******************************************************
            </pre>
            <button id="btnDownload" style="background: #27ae60; color: white; border: none; padding: 12px; width: 100%; border-radius: 50px; cursor: pointer; margin-top: 10px; font-weight: bold;">BAIXAR RELATÓRIO PDF</button>
        </div>`;
        
        document.getElementById('btnDownload').addEventListener('click', gerarPDF);
    }

    function gerarPDF() {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        const res = ultimoResultado;
        const formData = new FormData(document.getElementById('solarForm'));

        const sistema = res.tipo;

        // Configuracao de Fonte
        doc.setFont("courier", "bold");
        doc.setFontSize(10);

        let y = 20;
        const pular = 6;
        
        // CABEÇALHO FIXO
        let linhas = [
            "============================================================",
            "     SISTEMA DE DIMENSIONAMENTO SOLAR",
            "============================================================",
            `CEP da Instalacao: ${res.cep}`,
            `Sistema [ongrid / offgrid / hibrido]: ${sistema}`
        ];

        // DADOS DE ENTRADA
        if (sistema === 'OFFGRID') {
            linhas.push(`Consumo Medio Mensal (kWh): ${res.consumo}`);
            linhas.push(`Autonomia Desejada: ${res.bateriaInfo.autonomia} Dias`);
        } else {
            const grupo = formData.get('grupo').toUpperCase();
            const padrao = (res.grupo === 'B') ? formData.get('padrao').toUpperCase() : 'N/A';
            
            linhas.push(`Grupo Tarifario [A / B]: ${grupo}`);
            linhas.push(`Consumo Medio Mensal (kWh): ${res.consumo}`);
            if (res.grupo === 'B') {
                linhas.push(`Padrao Energisa [mono / bi / tri]: ${padrao}`);
            } else {
                linhas.push(`Demanda Contratada (kW): ${res.demanda}`);
            }
        }

        // DADOS DO PROJETO
        linhas.push("");
        linhas.push("*******************************************************");
        linhas.push("DADOS DO PROJETO");
        linhas.push(`Localizacao (CEP): ${res.cep}`);
        linhas.push(`Latitude: ${parseFloat(res.lat).toFixed(4)} | Longitude: ${parseFloat(res.lon).toFixed(4)}`);
        linhas.push(`Tipo de Sistema: ${sistema}`);
        
        if (sistema !== 'OFFGRID') {
            linhas.push(`Grupo Tarifario: ${formData.get('grupo').toUpperCase()}`);
        } else {
            linhas.push(`Tipo de Conexao: ISOLADO (Sem Rede)`);
        }

        // PARÂMETROS TÉCNICOS
        linhas.push("-------------------------------------------------------");
        linhas.push("PARAMETROS TECNICOS:");
        linhas.push(`HSP Local (CRESESB): ${res.hsp.toFixed(2)} kWh/m2.dia`);
        linhas.push(`Consumo Base: ${res.consumo.toFixed(1)} kWh`);
        linhas.push(`Taxa Disponibilidade (Consessinária): ${res.custo_disp} kWh`);
        linhas.push(`Meta de Geracao Total: ${res.meta_geracao.toFixed(2)} kWh/mes`);
        linhas.push("-------------------------------------------------------");
        linhas.push("DIMENSIONAMENTO DOS EQUIPAMENTOS:");
        linhas.push(`Paineis (430W): ${res.paineis} Unidades`);
        linhas.push(`Potencia Total Instalada: ${res.pot_final.toFixed(2)} kWp`);
        linhas.push(`Area de Telhado Estimada: ${res.area} m2`);
        linhas.push(`Inversor Recomendado: ${res.inv_sugerido} kW`);

        // ALERTAS E BATERIAS
        if (sistema !== 'OFFGRID' && res.grupo === 'A' && res.pot_final > res.demanda) {
            linhas.push("");
            linhas.push(`[!] ALERTA: Potencia (${res.pot_final.toFixed(1)}kWp) excede a Demanda (${res.demanda}kW)!`);
        }

        if (res.bateriaInfo) {
            linhas.push("-------------------------------------------------------");
            linhas.push("SISTEMA DE ARMAZENAMENTO:");
            linhas.push(`Tensao do Banco: ${res.bateriaInfo.tensao}V`);
            linhas.push(`Capacidade do Banco: ${res.bateriaInfo.ah} Ah`);
            linhas.push(`Controlador de Carga: ${res.bateriaInfo.controlador} A`);
            linhas.push(`Autonomia: ${res.bateriaInfo.autonomia} Dias`);
        }

        // 6. RODAPÉ
        linhas.push("-------------------------------------------------------");
        linhas.push("OBS: Verifique a estrutura mecanica do telhado.");
        linhas.push("*******************************************************");

        // IMPRESSÃO FINAL NO PDF
        linhas.forEach(linha => {
            if (linha.includes("[!] ALERTA")) {
                doc.setTextColor(200, 0, 0);
                doc.text(linha, 15, y);
                doc.setTextColor(0, 0, 0);
            } else {
                doc.text(linha, 15, y);
            }
            y += pular;
        });

        doc.save(`Relatorio_Solar_${res.cep}.pdf`);
    }
});