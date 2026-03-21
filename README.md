# Dimensionamento para Instalação de Placas Fotovoltaicas (Energia Solar)

Este repositório contém ferramentas que abrangem o cálculo técnico e o dimensionamento de sistemas fotovoltaicos (On-grid, Off-grid e Híbridos). O projeto foi desenvolvido com base em bibliografia técnica de instalação solar e utiliza dados reais de irradiação da LABREN.

---

## Demonstração do Projeto

https://github.com/user-attachments/assets/f095341f-aa21-4817-9209-11a1d36ee1cd

---

## O projeto está dividido em:

### 1. Script de Automação (Python)
Localizado na pasta `/py`, o `main.py` é um script que utiliza:
* **Geolocalização:** Converte o CEP em coordenadas geográficas via integração com a API `geopy`.
* **Web Scraping:** Consulta automaticamente o HSP (Horas de Sol Pleno) no banco de dados do CRESESB/CEPEL.
* **Dimensionamento:** Calcula a potência do gerador (kWp), número de painéis, inversor e, para sistemas isolados, o banco de baterias e controlador de carga.
* **Exportação em PDF:** Geração de relatório técnico utilizando a biblioteca `FPDF`.

### 2. Interface Interativa (GitHub Pages)
Uma aplicação web interativa (HTML / CSS / JS) hospedada no GitHub Pages que oferece uma experiência de usuário responsiva.
* **Tecnologias:** HTML5, CSS3 e JavaScript (Vanilla).
* **Atlas Solar Labren:** Processa o arquivo `atlas_labren.csv` (LABREN/INPE) para extrair dados precisos de irradiação solar via busca por proximidade de coordenadas (Distância Euclidiana).
* **Funcionalidades:**
  - Integração com APIs ViaCEP e Nominatim.
  - Geração de PDF diretamente no navegador usando `jsPDF`.
  - Lógica dinâmica de formulários (ex: ajuste de campos conforme o grupo tarifário A ou B).

---

## Tecnologias e Bibliotecas

| Categoria | Ferramentas |
| :--- | :--- |
| **Linguagens** | Python, JavaScript, HTML, CSS |
| **Bibliotecas Python** | `BeautifulSoup4`, `Requests`, `Geopy`, `FPDF` |
| **Bibliotecas Web** | `jsPDF`, `Remix Icon` |
| **Fontes de Dados** | CRESESB/CEPEL, Atlas Brasileiro de Energia Solar (LABREN) |

---

## Critérios Técnicos de Dimensionamento

O sistema baseia-se em normas técnicas de instalação solar, aplicando fórmulas para garantir a precisão:

* **Meta de Geração:** Considera o consumo médio somado à taxa de disponibilidade da concessionária (Grupo B - Mono/Bi/Trifásico).
  - $$E_{ger} = E_{consumo} + E_{disponibilidade}$$
* **Cálculo de Potência ($kWp$):** - $$P_{kwp} = \frac{E_{mes}}{HSP \cdot 30 \cdot \eta}$$
* **Performance Ratio ($\eta$):** Ajustado conforme o tipo de sistema: **On-grid (80%)**, **Híbrido (75%)** e **Off-grid (65%)**.
* **Sistemas com Bateria:** Cálculo de Ah considerando dias de autonomia e profundidade de descarga (DoD) de 50%.

---

## Como Utilizar

### Script Python
1. Instale as dependências:
   ```bash
   pip install requests beautifulsoup4 geopy fpdf urllib3

2. Execute o script:
   ```bash
   python py/main.py

### Versão Web
Acesse diretamente pelo navegador:
[kessiacz.github.io/dimensionamento-fotovoltaico](url)
