import { useCallback, useRef, useState } from 'react';

interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
interface ChatConfig { systemPrompt: string; initialMessageHistory: ChatMessage[]; contextWindowLength: number; }

export function useGroqLLM() {
    const apiKey = process.env.EXPO_PUBLIC_GROQ_API_KEY ?? '';
    const isReady = Boolean(apiKey);
    const [isGenerating, setIsGenerating] = useState(false);
    const [messageHistory, setMessageHistory] = useState<ChatMessage[]>([]);
    const historyRef = useRef<ChatMessage[]>([]);
    const systemPromptRef = useRef('');
    const contextWindowLengthRef = useRef(8);
    const abortControllerRef = useRef<AbortController | null>(null);
    const promptTokensRef = useRef(0);
    const generatedTokensRef = useRef(0);

    const configure = useCallback(({ chatConfig }: { chatConfig: ChatConfig }) => {
        systemPromptRef.current = chatConfig.systemPrompt;
        contextWindowLengthRef.current = chatConfig.contextWindowLength;
        historyRef.current = chatConfig.initialMessageHistory ?? [];
        setMessageHistory(historyRef.current);
        promptTokensRef.current = 0;
        generatedTokensRef.current = 0;
    }, []);

    const interrupt = useCallback(() => {
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
    }, []);

    const reload = useCallback(async () => {
        interrupt();
        historyRef.current = [];
        setMessageHistory([]);
    }, [interrupt]);

    const sendMessage = useCallback(async (
        userText: string,
        opts?: { onToken?: (token: string) => void }
    ) => {
        const controller = new AbortController();
        abortControllerRef.current = controller;
        const onToken = opts?.onToken;
        const userMsg: ChatMessage = { role: 'user', content: userText };
        const windowSize = contextWindowLengthRef.current * 2;
        const trimmedHistory = historyRef.current.slice(-windowSize);
        const messages = [
            { role: 'system' as const, content: systemPromptRef.current },
            ...trimmedHistory,
            userMsg,
        ];
        promptTokensRef.current = Math.round(messages.reduce((a, m) => a + m.content.length, 0) / 4);
        generatedTokensRef.current = 0;
        setIsGenerating(true);
        let assistantText = '';
        try {
            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify({
                    model: 'llama-3.3-70b-versatile',
                    messages,
                    max_tokens: 150,
                    temperature: 0.8,
                    stream: true,
                }),
                signal: controller.signal,
            });
            if (!response.ok) throw new Error(`Groq HTTP ${response.status}: ${await response.text()}`);
            const reader = response.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data: ')) continue;
                    const data = trimmed.slice(6);
                    if (data === '[DONE]') break;
                    try {
                        const content = JSON.parse(data)?.choices?.[0]?.delta?.content;
                        if (content) { assistantText += content; generatedTokensRef.current++; onToken?.(content); }
                    } catch {}
                }
            }
        } catch (e: any) {
            if (e?.name !== 'AbortError') throw e;
        } finally {
            abortControllerRef.current = null;
            setIsGenerating(false);
            const newHistory = [...trimmedHistory, userMsg, ...(assistantText ? [{ role: 'assistant' as const, content: assistantText }] : [])];
            historyRef.current = newHistory;
            setMessageHistory(newHistory);
        }
    }, [apiKey, interrupt]);

    return {
        isReady,
        isGenerating,
        messageHistory,
        configure,
        sendMessage,
        interrupt,
        reload,
        getPromptTokenCount: () => promptTokensRef.current,
        getGeneratedTokenCount: () => generatedTokensRef.current,
        getTotalTokenCount: () => promptTokensRef.current + generatedTokensRef.current,
    };
}
