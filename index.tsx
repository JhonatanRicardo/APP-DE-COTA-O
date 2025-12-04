import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { GoogleGenAI, Type } from "@google/genai";
import {
  Upload,
  Database,
  Search,
  CheckCircle,
  AlertCircle,
  FileSpreadsheet,
  Cpu,
  Loader2,
  DollarSign,
  Trash2,
  XCircle
} from "lucide-react";

// --- Types ---

interface InventoryItem {
  id: string;
  description: string;
  normalizedDesc: string; // Lowercase, no accents for search
  cost: number;
  type: "Componente" | "Tampa";
  sourceSheet: string;
  inStock: boolean;
  pricingRule: "standard" | "fallback"; // standard = x2, fallback = x3.5
}

interface QuoteRequest {
  originalText: string;
  status: "pending" | "processing" | "completed" | "not_found";
  matchedItem?: InventoryItem;
  finalPrice?: number;
  confidence?: string;
}

// --- Helper Functions ---

const normalizeText = (text: string) => {
  if (!text) return "";
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
};

const parseCurrency = (value: any): number => {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    // Handle "R$ 6,85" or "6.85"
    let clean = value.replace("R$", "").trim();
    clean = clean.replace(".", "").replace(",", "."); // Assume Brazilian format 1.000,00 -> 1000.00
    const floatVal = parseFloat(clean);
    return isNaN(floatVal) ? 0 : floatVal;
  }
  return 0;
};

// Round up to nearest multiple of 5 based on rule
const calculateFinalPrice = (cost: number, rule: "standard" | "fallback"): number => {
  // Standard: Cost * 2
  // Fallback (Componentes w/o Col D): Cost (from Col C) * 3.5
  const multiplier = rule === "fallback" ? 3.5 : 2.0;
  const rawPrice = cost * multiplier;
  
  // Formula: ceil(rawPrice / 5) * 5
  return Math.ceil(rawPrice / 5) * 5;
};

// --- Components ---

const App = () => {
  const [apiKey, setApiKey] = useState<string>(process.env.API_KEY || "");
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [quoteInput, setQuoteInput] = useState("");
  const [processedQuotes, setProcessedQuotes] = useState<QuoteRequest[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [view, setView] = useState<"upload" | "quote">("upload");
  const [statusMsg, setStatusMsg] = useState<{ type: "success" | "error" | "info"; text: string } | null>(null);

  // Load inventory from local storage on mount (simulating DB persistence)
  useEffect(() => {
    const savedInv = localStorage.getItem("app_inventory");
    if (savedInv) {
      try {
        const parsed = JSON.parse(savedInv);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setInventory(parsed);
          setView("quote"); // Go straight to quotes if data exists
          showStatus("success", `Banco de dados carregado: ${parsed.length} itens.`);
        }
      } catch (e) {
        console.error("Failed to load inventory", e);
      }
    }
  }, []);

  const showStatus = (type: "success" | "error" | "info", text: string) => {
    setStatusMsg({ type, text });
    setTimeout(() => setStatusMsg(null), 5000);
  };

  // --- Excel Processing ---

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // @ts-ignore - XLSX is loaded via CDN in index.html
    const XLSX = window.XLSX;

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const bstr = evt.target?.result;
        const workbook = XLSX.read(bstr, { type: "binary" });

        let newItems: InventoryItem[] = [];

        // Process "Componentes" Tab
        if (workbook.Sheets["Componentes"]) {
          const sheet = workbook.Sheets["Componentes"];
          // header: "A" maps columns to letters. A=Status, B=Desc, C=5Pcs, D=1Pc
          const data = XLSX.utils.sheet_to_json(sheet, { header: "A", range: 1 });
          
          data.forEach((row: any, index: number) => {
            const statusMark = row["A"]; // "F" = Out of stock
            const desc = row["B"];
            const cost5Pcs = parseCurrency(row["C"]);
            const cost1Pc = parseCurrency(row["D"]);

            const inStock = String(statusMark).trim().toUpperCase() !== "F";

            // Pricing Logic for Componentes:
            // 1. Try D (1 PC). If valid, standard rule (x2).
            // 2. Else try C (5 PCS). If valid, fallback rule (x3.5).
            
            let cost = 0;
            let rule: "standard" | "fallback" = "standard";

            if (cost1Pc > 0) {
              cost = cost1Pc;
              rule = "standard";
            } else if (cost5Pcs > 0) {
              cost = cost5Pcs;
              rule = "fallback";
            }

            if (desc && cost > 0) {
              newItems.push({
                id: `COMP-${index}-${Date.now()}`,
                description: String(desc).trim(),
                normalizedDesc: normalizeText(String(desc)),
                cost: cost,
                type: "Componente",
                sourceSheet: "Componentes",
                inStock: inStock,
                pricingRule: rule
              });
            }
          });
        }

        // Process "Tampas" Tab
        if (workbook.Sheets["Tampas"]) {
          const sheet = workbook.Sheets["Tampas"];
          const data = XLSX.utils.sheet_to_json(sheet, { header: "A", range: 1 });

          data.forEach((row: any, index: number) => {
            // Col A = Status, Col B = Desc, Col C = Cost
            const statusMark = row["A"];
            const desc = row["B"];
            const costRaw = row["C"];
            
            const inStock = String(statusMark).trim().toUpperCase() !== "F";

            if (desc) {
              newItems.push({
                id: `TAMP-${index}-${Date.now()}`,
                description: String(desc).trim(),
                normalizedDesc: normalizeText(String(desc)),
                cost: parseCurrency(costRaw),
                type: "Tampa",
                sourceSheet: "Tampas",
                inStock: inStock,
                pricingRule: "standard" // Tampas always x2
              });
            }
          });
        }

        if (newItems.length === 0) {
          showStatus("error", "Nenhum item válido encontrado. Verifique as abas e colunas.");
          return;
        }

        setInventory(newItems);
        localStorage.setItem("app_inventory", JSON.stringify(newItems));
        showStatus("success", `Importação concluída! ${newItems.length} itens salvos.`);
        setView("quote");
      } catch (error) {
        console.error(error);
        showStatus("error", "Erro ao processar arquivo. Verifique o formato.");
      }
    };
    reader.readAsBinaryString(file);
  };

  const clearDatabase = () => {
    if (confirm("Tem certeza que deseja apagar todo o banco de dados?")) {
      setInventory([]);
      localStorage.removeItem("app_inventory");
      showStatus("info", "Banco de dados limpo.");
      setView("upload");
    }
  };

  // --- AI Logic ---

  const findBestMatch = async (query: string): Promise<InventoryItem | null> => {
    if (!apiKey) return null;

    const normalizedQuery = normalizeText(query);
    const queryTokens = normalizedQuery.split(" ").filter(t => t.length > 2);

    // 1. Client-side Pre-filter
    const candidates = inventory.filter((item) => {
      // Basic inclusion check
      return queryTokens.some(token => item.normalizedDesc.includes(token));
    });

    const scoredCandidates = candidates.map(item => {
      let score = 0;
      queryTokens.forEach(token => {
        if (item.normalizedDesc.includes(token)) score++;
      });
      return { item, score };
    }).sort((a, b) => b.score - a.score).slice(0, 40);

    if (scoredCandidates.length === 0) return null;

    const candidateList = scoredCandidates.map(c => ({
      id: c.item.id,
      desc: c.item.description,
      type: c.item.type,
      inStock: c.item.inStock
    }));

    // 2. Gemini Reasoning
    try {
      const ai = new GoogleGenAI({ apiKey });
      
      const prompt = `
      Você é um especialista em peças de celular.
      Usuário pede: "${query}"
      
      Estoque disponível (Top candidatos):
      ${JSON.stringify(candidateList)}

      Tarefa:
      1. Encontre o item que melhor corresponde ao pedido.
      2. Considere sinônimos (ex: "flex" = "dock", "tampa" = "carcaça").
      3. Se o item exato não existir, mas houver um muito próximo, selecione-o.
      4. Retorne JSON: { "matchedId": "ID_DO_ITEM" } ou { "matchedId": null }.
      `;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              matchedId: { type: Type.STRING, nullable: true }
            }
          }
        }
      });

      const resultText = response.text;
      const resultJson = JSON.parse(resultText);

      if (resultJson.matchedId) {
        return inventory.find(i => i.id === resultJson.matchedId) || null;
      }
      return null;

    } catch (error) {
      console.error("AI Error:", error);
      return null;
    }
  };

  const processQuotes = async () => {
    if (!quoteInput.trim()) return;
    setIsProcessing(true);
    setProcessedQuotes([]); 

    const lines = quoteInput.split("\n").filter(line => {
      const l = normalizeText(line);
      return l.length > 3 && !["bom dia", "boa tarde", "boa noite", "ola", "tchau"].includes(l);
    });

    const promises = lines.map(async (line) => {
      const match = await findBestMatch(line);
      
      const res: QuoteRequest = {
        originalText: line,
        status: match ? "completed" : "not_found",
        matchedItem: match || undefined,
        finalPrice: match ? calculateFinalPrice(match.cost, match.pricingRule) : undefined
      };
      return res;
    });

    const resolvedResults = await Promise.all(promises);
    setProcessedQuotes(resolvedResults);
    setIsProcessing(false);
  };

  // --- Render ---

  const totalValue = processedQuotes.reduce((acc, curr) => {
    // Only sum if in stock
    if (curr.matchedItem && curr.matchedItem.inStock && curr.finalPrice) {
      return acc + curr.finalPrice;
    }
    return acc;
  }, 0);

  return (
    <div className="min-h-screen max-w-6xl mx-auto p-4 md:p-8">
      
      {/* Header */}
      <header className="flex flex-col md:flex-row justify-between items-center mb-8 bg-white p-6 rounded-xl shadow-sm border border-gray-200">
        <div className="flex items-center gap-3 mb-4 md:mb-0">
          <div className="bg-blue-600 p-2 rounded-lg text-white">
            <Cpu size={28} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-800">Cotação Inteligente</h1>
            <p className="text-sm text-gray-500">Sistema de precificação com IA e Estoque</p>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => setView("upload")}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
              view === "upload" ? "bg-blue-100 text-blue-700 font-medium" : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            <Database size={18} />
            Banco de Dados
          </button>
          <button
            onClick={() => setView("quote")}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
              view === "quote" ? "bg-blue-100 text-blue-700 font-medium" : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            <DollarSign size={18} />
            Nova Cotação
          </button>
        </div>
      </header>

      {/* Notifications */}
      {statusMsg && (
        <div className={`mb-6 p-4 rounded-lg flex items-center gap-3 ${
          statusMsg.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' :
          statusMsg.type === 'error' ? 'bg-red-50 text-red-700 border border-red-200' :
          'bg-blue-50 text-blue-700 border border-blue-200'
        }`}>
          {statusMsg.type === 'success' && <CheckCircle size={20} />}
          {statusMsg.type === 'error' && <AlertCircle size={20} />}
          {statusMsg.type === 'info' && <CheckCircle size={20} />}
          <span>{statusMsg.text}</span>
        </div>
      )}

      {/* Upload View */}
      {view === "upload" && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8">
          <h2 className="text-xl font-semibold mb-6 flex items-center gap-2">
            <Upload size={24} className="text-blue-600" />
            Carregar Planilha
          </h2>
          
          <div className="border-2 border-dashed border-gray-300 rounded-xl p-10 flex flex-col items-center justify-center text-center bg-gray-50 hover:bg-gray-100 transition-colors cursor-pointer relative">
            <input 
              type="file" 
              accept=".xlsx, .xls"
              onChange={handleFileUpload}
              className="absolute inset-0 opacity-0 cursor-pointer"
            />
            <FileSpreadsheet size={48} className="text-gray-400 mb-4" />
            <p className="text-lg font-medium text-gray-700">Clique ou arraste sua planilha aqui</p>
            <p className="text-sm text-gray-500 mt-2">Formatos suportados: .xlsx</p>
            <p className="text-xs text-gray-400 mt-4 max-w-md">
              O sistema verifica "Componentes" e "Tampas".
              Coluna A = "F" indica sem estoque.
            </p>
          </div>

          <div className="mt-8">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-gray-700">Resumo do Banco de Dados</h3>
              {inventory.length > 0 && (
                <button 
                  onClick={clearDatabase}
                  className="text-red-500 text-sm hover:underline flex items-center gap-1"
                >
                  <Trash2 size={14} /> Limpar tudo
                </button>
              )}
            </div>
            <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-center">
                <div className="bg-white p-3 rounded shadow-sm">
                  <p className="text-xs text-gray-500 uppercase">Total Itens</p>
                  <p className="text-2xl font-bold text-gray-800">{inventory.length}</p>
                </div>
                <div className="bg-white p-3 rounded shadow-sm">
                  <p className="text-xs text-gray-500 uppercase">Componentes</p>
                  <p className="text-2xl font-bold text-blue-600">
                    {inventory.filter(i => i.type === "Componente").length}
                  </p>
                </div>
                <div className="bg-white p-3 rounded shadow-sm">
                  <p className="text-xs text-gray-500 uppercase">Tampas</p>
                  <p className="text-2xl font-bold text-orange-600">
                    {inventory.filter(i => i.type === "Tampa").length}
                  </p>
                </div>
                 <div className="bg-white p-3 rounded shadow-sm">
                  <p className="text-xs text-gray-500 uppercase">Disponíveis</p>
                  <p className="text-2xl font-bold text-green-600">
                    {inventory.filter(i => i.inStock).length}
                  </p>
                </div>
                 <div className="bg-white p-3 rounded shadow-sm">
                  <p className="text-xs text-gray-500 uppercase">Sem Estoque</p>
                  <p className="text-2xl font-bold text-red-600">
                    {inventory.filter(i => !i.inStock).length}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Quote View */}
      {view === "quote" && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* Left Column: Input */}
          <div className="lg:col-span-1 bg-white rounded-xl shadow-sm border border-gray-200 p-6 flex flex-col h-fit">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Search size={20} className="text-blue-600" />
              Solicitação
            </h2>
            <textarea
              value={quoteInput}
              onChange={(e) => setQuoteInput(e.target.value)}
              placeholder={`Exemplo:\ncotar flex biometria a11 vermelho\ntampa j7 prime preta`}
              className="w-full h-64 p-4 bg-gray-50 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none text-sm mb-4"
            />
            <button
              onClick={processQuotes}
              disabled={isProcessing || inventory.length === 0}
              className={`w-full py-3 rounded-lg flex items-center justify-center gap-2 text-white font-medium shadow-sm transition-all
                ${isProcessing || inventory.length === 0 
                  ? "bg-gray-400 cursor-not-allowed" 
                  : "bg-blue-600 hover:bg-blue-700 hover:shadow-md"
                }`}
            >
              {isProcessing ? (
                <>
                  <Loader2 size={20} className="animate-spin" />
                  Analisando...
                </>
              ) : (
                <>
                  <Cpu size={20} />
                  Processar Cotação
                </>
              )}
            </button>
            <div className="mt-4 p-3 bg-blue-50 rounded-lg text-xs text-blue-700 border border-blue-100">
              <p className="font-semibold mb-1">Regras de Preço:</p>
              <ul className="list-disc pl-4 space-y-1">
                <li>Componentes (1PC): Custo x 2</li>
                <li>Componentes (5PCS): Custo x 3.5</li>
                <li>Tampas: Custo x 2</li>
                <li>Arredondamento: Sempre para cima (múltiplo de 5)</li>
              </ul>
            </div>
          </div>

          {/* Right Column: Results */}
          <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-gray-200 p-6 flex flex-col">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <FileSpreadsheet size={20} className="text-green-600" />
                Resultado
              </h2>
              {processedQuotes.length > 0 && (
                <div className="bg-green-100 px-4 py-2 rounded-lg border border-green-200">
                  <span className="text-xs text-green-800 uppercase font-bold mr-2">Total Disponível</span>
                  <span className="text-xl font-bold text-green-700">
                    R$ {totalValue.toFixed(2).replace('.', ',')}
                  </span>
                </div>
              )}
            </div>

            <div className="overflow-auto flex-1">
              {processedQuotes.length === 0 ? (
                <div className="h-64 flex flex-col items-center justify-center text-gray-400 border-2 border-dashed border-gray-100 rounded-xl">
                  <Search size={48} className="mb-4 opacity-20" />
                  <p>Os resultados aparecerão aqui</p>
                </div>
              ) : (
                <table className="w-full text-sm text-left">
                  <thead className="bg-gray-50 text-gray-600 font-medium border-b border-gray-200">
                    <tr>
                      <th className="px-4 py-3">Pedido</th>
                      <th className="px-4 py-3">Item Encontrado</th>
                      <th className="px-4 py-3 text-right">Base</th>
                      <th className="px-4 py-3 text-right">Final</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {processedQuotes.map((quote, idx) => {
                      const inStock = quote.matchedItem?.inStock ?? false;
                      return (
                        <tr key={idx} className={`hover:bg-gray-50 transition-colors ${!inStock && quote.matchedItem ? 'bg-red-50 hover:bg-red-100' : ''}`}>
                          <td className="px-4 py-3 text-gray-800 font-medium w-1/3 align-top">
                            {quote.originalText}
                          </td>
                          <td className="px-4 py-3 text-gray-600 w-1/3 align-top">
                            {quote.status === "completed" && quote.matchedItem ? (
                              <div>
                                <div className={`font-medium ${inStock ? 'text-blue-700' : 'text-red-700 line-through'}`}>
                                  {quote.matchedItem.description}
                                </div>
                                <div className="text-xs text-gray-500 flex flex-wrap items-center gap-2 mt-1">
                                  <span className="bg-gray-200 px-1.5 rounded">{quote.matchedItem.type}</span>
                                  {!inStock && (
                                    <span className="bg-red-200 text-red-800 px-1.5 rounded font-bold flex items-center gap-1">
                                      <XCircle size={10} /> SEM ESTOQUE
                                    </span>
                                  )}
                                  {quote.matchedItem.pricingRule === 'fallback' && (
                                    <span className="bg-yellow-100 text-yellow-800 px-1.5 rounded" title="Baseado no preço de 5 peças">Regra 5PCS</span>
                                  )}
                                </div>
                              </div>
                            ) : (
                              <span className="text-gray-400 italic flex items-center gap-1">
                                <AlertCircle size={14} /> Não encontrado
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right text-gray-400 font-mono align-top">
                            {quote.matchedItem ? `R$ ${quote.matchedItem.cost.toFixed(2).replace('.', ',')}` : '-'}
                          </td>
                          <td className="px-4 py-3 text-right font-bold font-mono align-top">
                            {quote.matchedItem ? (
                              <span className={inStock ? "text-gray-800" : "text-red-400"}>
                                R$ {quote.finalPrice?.toFixed(2).replace('.', ',')}
                              </span>
                            ) : '-'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Mount App
const container = document.getElementById("root");
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}