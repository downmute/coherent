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
    const xhrRef = useRef<XMLHttpRequest | null>(null);
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
        xhrRef.current?.abort();
        xhrRef.current = null;
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
            await new Promise<void>((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhrRef.current = xhr;
                let lastIndex = 0;

                const processChunk = (newText: string) => {
                    const lines = newText.split('\n');
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed.startsWith('data: ')) continue;
                        const data = trimmed.slice(6);
                        if (data === '[DONE]') return;
                        try {
                            const content = JSON.parse(data)?.choices?.[0]?.delta?.content;
                            if (content) { assistantText += content; generatedTokensRef.current++; onToken?.(content); }
                        } catch {}
                    }
                };

                xhr.onreadystatechange = () => {
                    if (xhr.readyState >= 3 && xhr.responseText) {
                        const newText = xhr.responseText.slice(lastIndex);
                        lastIndex = xhr.responseText.length;
                        processChunk(newText);
                    }
                    if (xhr.readyState === 4) {
                        xhrRef.current = null;
                        // status 0 = aborted — treat as clean cancel
                        if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) {
                            resolve();
                        } else {
                            reject(new Error(`Groq HTTP ${xhr.status}: ${xhr.responseText}`));
                        }
                    }
                };

                xhr.onerror = () => { xhrRef.current = null; reject(new Error('Network request failed')); };

                xhr.open('POST', 'https://api.groq.com/openai/v1/chat/completions');
                xhr.setRequestHeader('Content-Type', 'application/json');
                xhr.setRequestHeader('Authorization', `Bearer ${apiKey}`);
                xhr.send(JSON.stringify({
                    model: 'llama-3.3-70b-versatile',
                    messages,
                    max_tokens: 150,
                    temperature: 0.8,
                    stream: true,
                }));
            });
        } catch (e: any) {
            // Aborts resolve() cleanly (status 0), so only real errors reach here
            throw e;
        } finally {
            xhrRef.current = null;
            setIsGenerating(false);
            const newHistory = [...trimmedHistory, userMsg, ...(assistantText ? [{ role: 'assistant' as const, content: assistantText }] : [])];
            historyRef.current = newHistory;
            setMessageHistory(newHistory);
        }
    }, [apiKey]);

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
