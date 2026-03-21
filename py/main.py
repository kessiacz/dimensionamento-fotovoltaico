import math
import requests
import urllib3
from bs4 import BeautifulSoup
from geopy.geocoders import Nominatim
from fpdf import FPDF

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

def gerar_pdf(conteudo_texto, cep):
    try:
        pdf = FPDF()
        pdf.add_page()
        pdf.set_font("Arial", 'B', 16)
        pdf.cell(200, 10, txt="RELATORIO TECNICO DE DIMENSIONAMENTO SOLAR", ln=True, align='C')
        pdf.ln(10)
        pdf.set_font("Arial", size=12)
        
        # Evitar erros de codificação
        texto_limpo = (conteudo_texto.replace('²', '2').replace('°', 'o')
                       .replace('ã', 'a').replace('ç', 'c').replace('ê', 'e')
                       .replace('ó', 'o').replace('í', 'i').replace('á', 'a')
                       .replace('é', 'e'))
        
        for linha in texto_limpo.split('\n'):
            pdf.cell(200, 8, txt=linha, ln=True, align='L')
        
        nome_arquivo = f"Relatorio_Solar_{cep}.pdf"
        pdf.output(nome_arquivo)
        print(f"\n[SUCESSO] Relatorio salvo como: {nome_arquivo}")
    except Exception as e:
        print(f"\n[ERRO] Falha ao gerar arquivo PDF: {e}")

def obter_coordenadas_por_cep(cep):
    """Obtem Latitude e Longitude via API Geopy."""
    geolocator = Nominatim(user_agent="solar_pb_app")
    try:
        location = geolocator.geocode(f"{cep}, Brazil")
        return (location.latitude, location.longitude) if location else (None, None)
    except: return None, None

def consultar_hsp_cresesb(lat, lon):
    """Busca HSP (Horas de Sol Pleno) no banco de dados do CRESESB/CEPEL."""
    if not lat: return 0.0
    url = f"https://www.cresesb.cepel.br/index.php?section=sundata&latitude={round(lat,4)}&longitude={round(lon,4)}"
    try:
        headers = {'User-Agent': 'Mozilla/5.0'}
        response = requests.get(url, headers=headers, timeout=20, verify=False)
        soup = BeautifulSoup(response.text, 'html.parser')
        tabela = soup.find('table', {'id': 'tb_sundata'})
        if tabela:
            # Seleciona a média anual
            valor = tabela.find('tbody').find('tr').find_all('td')[-2].get_text().strip()
            return float(valor.replace(',', '.'))
        return 0.0
    except: return 0.0

# --- INTERFACE ---
print("="*60)
print("     SISTEMA DE DIMENSIONAMENTO SOLAR")
print("="*60)

cep_input = input("CEP da Instalacao: ").strip()
tipo_sys = input("Sistema [ongrid / offgrid / hibrido]: ").lower().strip()
grupo = input("Grupo Tarifario [A / B]: ").upper().strip()
media_kwh = float(input("Consumo Medio Mensal (kWh): "))

custo_disp = 0
demanda = 0

# Logica de Taxas e Grupos
if grupo == 'B' and 'off' not in tipo_sys:
    padrao = input("Padrao Energisa [mono / bi / tri]: ").lower().strip()
    custo_disp = {'mono': 30, 'bi': 50, 'tri': 100}.get(padrao, 50)
elif grupo == 'A':
    demanda = float(input("Demanda Contratada (kW): "))

dias_autonomia = 0
if 'off' in tipo_sys or 'hibrido' in tipo_sys:
    dias_autonomia = int(input("Dias de autonomia desejados: "))

# --- PROCESSAMENTO ---
lat, lon = obter_coordenadas_por_cep(cep_input)
hsp = consultar_hsp_cresesb(lat, lon)

if hsp > 0:
    meta_geracao = media_kwh + custo_disp
    # Rendimentos (Performance Ratio)
    eff = {'ongrid': 0.80, 'offgrid': 0.65, 'hibrido': 0.75}.get(tipo_sys, 0.80)
    
    # Calculo da Potência do Gerador (kWp)
    pot_kwp = meta_geracao / (hsp * 30 * eff)
    paineis = math.ceil((pot_kwp * 1000) / 430)
    pot_final = (paineis * 430) / 1000
    
    # Calculo do Inversor (Overload padrão de 15% para On-grid)
    overload = 1.15 if 'off' not in tipo_sys else 1.0
    inv_sugerido = pot_final / overload

    # --- CONSTRUCAO DO RELATORIO ---
    relatorio = f"DADOS DO PROJETO\n"
    relatorio += f"Localizacao (CEP): {cep_input}\n"
    relatorio += f"Latitude: {lat:.4f} | Longitude: {lon:.4f}\n"
    relatorio += f"Tipo de Sistema: {tipo_sys.upper()}\n"
    relatorio += f"Grupo Tarifario: {grupo}\n"
    relatorio += f"-------------------------------------------------------\n"
    relatorio += f"PARAMETROS TECNICOS:\n"
    relatorio += f"HSP Local (CRESESB): {hsp} kWh/m2.dia\n"
    relatorio += f"Consumo Base: {media_kwh} kWh\n"
    relatorio += f"Taxa Disponibilidade (Consessinária): {custo_disp} kWh\n"
    relatorio += f"Meta de Geracao Total: {meta_geracao:.2f} kWh/mes\n"
    relatorio += f"-------------------------------------------------------\n"
    relatorio += f"DIMENSIONAMENTO DOS EQUIPAMENTOS:\n"
    relatorio += f"Paineis (430W): {paineis} Unidades\n"
    relatorio += f"Potencia Total Instalada: {pot_final:.2f} kWp\n"
    relatorio += f"Area de Telhado Estimada: {paineis * 2.2:.1f} m2\n"
    relatorio += f"Inversor Recomendado: {inv_sugerido:.1f} kW\n"

    # Verificação de restrição tecnica para Grupo A
    if grupo == 'A' and pot_final > demanda:
        relatorio += f"\n[!] ALERTA: Potencia ({pot_final:.1f}kWp) excede a Demanda ({demanda}kW)!\n"

    if 'off' in tipo_sys or 'hibrido' in tipo_sys:
        if pot_final <= 2.0:
            tensao = 12
        elif pot_final <= 4.0:
            tensao = 24
        else:
            tensao = 48
            
        bateria_ah = math.ceil(((meta_geracao/30)*1000*dias_autonomia)/(tensao*0.5))
        controlador = math.ceil(((pot_final*1000)/tensao)*1.1)
        
        relatorio += f"-------------------------------------------------------\n"
        relatorio += f"SISTEMA DE ARMAZENAMENTO:\n"
        relatorio += f"Tensao do Banco: {tensao}V\n"
        relatorio += f"Capacidade do Banco: {bateria_ah} Ah\n"
        relatorio += f"Controlador de Carga: {controlador} A\n"
        relatorio += f"Autonomia: {dias_autonomia} Dias\n"

    relatorio += f"-------------------------------------------------------\n"
    relatorio += f"OBS: Verifique a estrutura mecanica do telhado."

    print("\n" + "*"*55)
    print(relatorio)
    print("*"*55)

    if input("\nDeseja salvar este relatorio em PDF? (s/n): ").lower().strip() == 's':
        gerar_pdf(relatorio, cep_input)
else:
    print("\n[ERRO]: Dados solares indisponiveis. Verifique conexao ou CEP.")