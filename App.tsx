import React, { useState, useRef, useEffect } from 'react';
import { AIPersona, DebatePhase, DebateMessage, Votes } from './types';
import { getDebateSides, generateDebateTurnStream, generateSpeech, generateDebateSummary } from './services/geminiService';
import { decode, decodeAudioData } from './utils/audioUtils';
import { LoadingSpinner, SendIcon, BrainIcon } from './components/icons';

const App: React.FC = () => {
    const [phase, setPhase] = useState<DebatePhase>(DebatePhase.IDLE);
    const [question, setQuestion] = useState<string>('');
    const [sides, setSides] = useState<{ [key in AIPersona]: string }>({ [AIPersona.Logos]: '', [AIPersona.Pathos]: '' });
    const [messages, setMessages] = useState<DebateMessage[]>([]);
    const [votes, setVotes] = useState<Votes>({ [AIPersona.Logos]: 0, [AIPersona.Pathos]: 0 });
    const [error, setError] = useState<string | null>(null);
    const [statusText, setStatusText] = useState<string>('');
    const [speakingMessageIndex, setSpeakingMessageIndex] = useState<number | null>(null);
    const [summary, setSummary] = useState<{ logosSummary: string[], pathosSummary: string[] } | null>(null);

    const audioContextRef = useRef<AudioContext | null>(null);
    const debateLogRef = useRef<HTMLDivElement>(null);

    const debateTurns = [
        { persona: AIPersona.Logos, stage: 'OPENING' },
        { persona: AIPersona.Pathos, stage: 'OPENING' },
        { persona: AIPersona.Logos, stage: 'REBUTTAL' },
        { persona: AIPersona.Pathos, stage: 'REBUTTAL' },
        { persona: AIPersona.Logos, stage: 'CLOSING' },
        { persona: AIPersona.Pathos, stage: 'CLOSING' },
    ];

    useEffect(() => {
        if (debateLogRef.current) {
            debateLogRef.current.scrollTop = debateLogRef.current.scrollHeight;
        }
    }, [messages, statusText]);

    const initializeAudio = () => {
        if (!audioContextRef.current) {
            try {
                const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
                audioContextRef.current = new AudioContext({ sampleRate: 24000 });
            } catch (e) {
                setError("Web Audio API is not supported in this browser.");
                console.error("Error creating AudioContext:", e);
                throw e; // re-throw to be caught by caller
            }
        }
    };
    
    const handleStartDebate = async () => {
        if (!question.trim()) {
            setError("Please enter a question to debate.");
            return;
        }
        setError(null);
        setPhase(DebatePhase.ANALYZING);
        setMessages([]);
        setSpeakingMessageIndex(null);
        setSummary(null);

        try {
            setStatusText('Analyzing question and defining stances...');
            const { sideA, sideB } = await getDebateSides(question);
            const currentSides = { [AIPersona.Logos]: sideA, [AIPersona.Pathos]: sideB };
            setSides(currentSides);
            
            const systemMessages: DebateMessage[] = [
                { persona: 'SYSTEM', text: `Topic: "${question}"` },
                { persona: 'SYSTEM', text: `${AIPersona.Logos} will argue: "${sideA}"` },
                { persona: 'SYSTEM', text: `${AIPersona.Pathos} will argue: "${sideB}"` },
            ];
            setMessages(systemMessages);
            
            await runDebate(systemMessages, currentSides, question);

        } catch (err: any) {
            setError(err.message || "Failed to start debate.");
            setPhase(DebatePhase.IDLE);
        }
    };
    
    const runDebate = async (systemMessages: DebateMessage[], currentSides: typeof sides, currentQuestion: string) => {
        // === PART 1: Generate all debate text first ===
        setStatusText('Generating debate script...');
        const generatedMessages: DebateMessage[] = [];
        let currentHistory = [...systemMessages];

        for (const turn of debateTurns) {
            const { persona, stage } = turn;
            const side = currentSides[persona];
            const tempMessage: DebateMessage = { persona, text: '...', isStreaming: true };
            
            const placeholderIndex = systemMessages.length + generatedMessages.length;
            setMessages(prev => [...prev, tempMessage]);

            const stream = await generateDebateTurnStream(currentHistory, persona, side, stage, currentQuestion);
            let fullText = '';
            for await (const chunk of stream) {
                fullText += chunk.text;
                setMessages(prev => {
                    const newMessages = [...prev];
                    newMessages[placeholderIndex] = { ...newMessages[placeholderIndex], text: fullText };
                    return newMessages;
                });
            }

            const finalMessage: DebateMessage = { persona, text: fullText, isStreaming: false };
            generatedMessages.push(finalMessage);
            currentHistory.push(finalMessage);

            setMessages(prev => {
                const newMessages = [...prev];
                newMessages[placeholderIndex] = finalMessage;
                return newMessages;
            });
        }
        
        // === PART 2: Generate Summary ===
        setStatusText('Generating debate summary...');
        try {
            const debateSummary = await generateDebateSummary(currentHistory);
            setSummary(debateSummary);
        } catch(err: any) {
            console.error("Failed to generate summary:", err.message);
        }

        // === PART 3: Generate and play audio with pipelining ===
        setPhase(DebatePhase.DEBATING);
        setStatusText('Debate script generated. Starting playback...');
        
        initializeAudio();
        
        let nextAudioPromise: Promise<string> | null = null;
        const firstMessageOffset = systemMessages.length;
        
        for (let i = 0; i < generatedMessages.length; i++) {
            const currentMessage = generatedMessages[i];
            const messageIndex = firstMessageOffset + i;
            
            setSpeakingMessageIndex(messageIndex);
            setStatusText(`Speaking: ${currentMessage.persona} (${debateTurns[i].stage})`);

            let currentAudioData: string;

            if (nextAudioPromise) {
                currentAudioData = await nextAudioPromise;
            } else {
                currentAudioData = await generateSpeech(currentMessage.text, currentMessage.persona as AIPersona);
            }

            if (i + 1 < generatedMessages.length) {
                const nextMessage = generatedMessages[i+1];
                nextAudioPromise = generateSpeech(nextMessage.text, nextMessage.persona as AIPersona);
            } else {
                nextAudioPromise = null;
            }
            
            if (currentAudioData) {
                await playAudio(currentAudioData);
            }
        }

        setSpeakingMessageIndex(null);
        setStatusText('');
        setPhase(DebatePhase.VOTING);
    }

    const playAudio = async (base64Audio: string) => {
        if (!audioContextRef.current) return;
        const decodedData = decode(base64Audio);
        const audioBuffer = await decodeAudioData(decodedData, audioContextRef.current, 24000, 1);
        
        return new Promise<void>((resolve) => {
            const source = audioContextRef.current!.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(audioContextRef.current!.destination);
            source.onended = () => resolve();
            source.start();
        });
    };

    const handleVote = (persona: AIPersona) => {
        setVotes(prev => ({ ...prev, [persona]: prev[persona] + 1 }));
        setPhase(DebatePhase.FINISHED);
    };

    const handleReset = () => {
        setPhase(DebatePhase.IDLE);
        setQuestion('');
        setMessages([]);
        setError(null);
        setVotes({ [AIPersona.Logos]: 0, [AIPersona.Pathos]: 0 });
        setSpeakingMessageIndex(null);
        setStatusText('');
        setSummary(null);
    };
    
    const renderIdle = () => (
        <div className="w-full max-w-2xl mx-auto">
            <h1 className="text-4xl font-bold text-center mb-2 text-gray-800">AI Debate Chamber</h1>
            <p className="text-center text-gray-500 mb-8">Enter a complex ethical or philosophical question to see two AI personas debate it.</p>
            <div className="flex items-center bg-white rounded-full shadow-lg p-2">
                <BrainIcon className="w-6 h-6 text-gray-400 mx-3" />
                <input
                    type="text"
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    placeholder="e.g., Should AI have rights?"
                    className="w-full bg-transparent outline-none text-gray-700"
                    onKeyDown={(e) => e.key === 'Enter' && handleStartDebate()}
                />
                <button
                    onClick={handleStartDebate}
                    className="bg-blue-600 text-white rounded-full p-3 hover:bg-blue-700 transition-colors disabled:bg-gray-400"
                    disabled={!question.trim() || phase === DebatePhase.ANALYZING}
                >
                    <SendIcon className="w-6 h-6" />
                </button>
            </div>
            {error && <p className="text-red-500 text-center mt-4">{error}</p>}
        </div>
    );

    const renderDebate = () => (
        <div className="w-full h-full flex flex-col bg-white rounded-2xl shadow-2xl overflow-hidden">
            <div className="p-4 border-b">
                <h2 className="text-lg font-semibold text-gray-800 truncate">Debate: {question}</h2>
                {statusText && (
                     <p className="text-sm text-gray-500 h-5 flex items-center">
                        {phase === DebatePhase.ANALYZING && <LoadingSpinner className="w-4 h-4 mr-2" />}
                        {statusText}
                        {(phase === DebatePhase.ANALYZING || phase === DebatePhase.DEBATING) && <span className="animate-pulse">...</span>}
                    </p>
                )}
            </div>
            <div ref={debateLogRef} className="flex-grow p-4 space-y-4 overflow-y-auto">
                {messages.map((msg, index) => (
                    <div 
                        key={index} 
                        className={`flex items-start gap-3 max-w-xl transition-all duration-300 ${msg.persona === AIPersona.Logos ? 'ml-auto flex-row-reverse' : msg.persona === AIPersona.Pathos ? 'mr-auto' : 'mx-auto'} ${speakingMessageIndex === index ? 'scale-105' : ''}`}
                    >
                        {msg.persona !== 'SYSTEM' && (
                            <div className={`w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center font-bold text-white ${msg.persona === AIPersona.Logos ? 'bg-blue-600' : 'bg-purple-600'}`}>
                                {msg.persona.slice(0, 1)}
                            </div>
                        )}
                        <div className={`p-3 rounded-lg relative ${
                            msg.persona === AIPersona.Logos ? 'bg-blue-100 text-blue-900' :
                            msg.persona === AIPersona.Pathos ? 'bg-purple-100 text-purple-900' :
                            'bg-gray-200 text-gray-700 text-center w-full'
                        } ${speakingMessageIndex === index ? 'ring-2 ring-yellow-400' : ''}`}>
                            <p className="text-sm">{msg.text}{msg.isStreaming && <span className="inline-block w-1 h-4 bg-gray-600 animate-pulse ml-1"></span>}</p>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
    
    const renderVoting = () => (
        <div className="text-center bg-white p-8 rounded-2xl shadow-2xl w-full max-w-4xl mx-auto">
            <h2 className="text-3xl font-bold mb-2 text-gray-800">Who Won the Debate?</h2>
            <p className="text-gray-600 mb-8">Review the key arguments and cast your vote.</p>

            {summary ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-10 text-left">
                    <div className="bg-blue-50 p-6 rounded-lg border border-blue-200">
                        <h3 className="text-xl font-bold mb-4 text-blue-800 flex items-center gap-2">
                            <div className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center font-bold text-white bg-blue-600">L</div>
                            Logos's Arguments
                        </h3>
                        <ul className="space-y-2 list-disc list-inside text-blue-900">
                            {summary.logosSummary.map((point, i) => <li key={`logos-${i}`}>{point}</li>)}
                        </ul>
                    </div>
                    <div className="bg-purple-50 p-6 rounded-lg border border-purple-200">
                        <h3 className="text-xl font-bold mb-4 text-purple-800 flex items-center gap-2">
                             <div className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center font-bold text-white bg-purple-600">P</div>
                            Pathos's Arguments
                        </h3>
                        <ul className="space-y-2 list-disc list-inside text-purple-900">
                            {summary.pathosSummary.map((point, i) => <li key={`pathos-${i}`}>{point}</li>)}
                        </ul>
                    </div>
                </div>
            ) : (
                <div className="mb-10 flex justify-center items-center h-48">
                    <LoadingSpinner /> 
                    <p className="ml-4 text-gray-500">Generating summary...</p>
                </div>
            )}
            
            <div className="flex justify-center gap-8">
                <button 
                    onClick={() => handleVote(AIPersona.Logos)} 
                    className="bg-blue-600 text-white font-bold py-4 px-8 rounded-lg hover:bg-blue-700 transition-transform hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed"
                    disabled={!summary}
                >
                    Vote for Logos
                </button>
                <button 
                    onClick={() => handleVote(AIPersona.Pathos)} 
                    className="bg-purple-600 text-white font-bold py-4 px-8 rounded-lg hover:bg-purple-700 transition-transform hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed"
                    disabled={!summary}
                >
                    Vote for Pathos
                </button>
            </div>
        </div>
    );

    const renderFinished = () => {
        const winner = votes[AIPersona.Logos] > votes[AIPersona.Pathos] ? AIPersona.Logos : AIPersona.Pathos;
        const winnerText = votes[AIPersona.Logos] === votes[AIPersona.Pathos] ? "It's a tie!" : `${winner} wins the debate!`;
        return (
            <div className="text-center">
                <h2 className="text-3xl font-bold mb-4 text-gray-800">Debate Finished!</h2>
                <p className="text-2xl text-green-600 font-semibold mb-8">{winnerText}</p>
                <button onClick={handleReset} className="bg-gray-700 text-white font-bold py-3 px-6 rounded-lg hover:bg-gray-800 transition-colors">
                    Start a New Debate
                </button>
            </div>
        );
    };

    const renderContent = () => {
        switch (phase) {
            case DebatePhase.IDLE:
                return renderIdle();
            case DebatePhase.ANALYZING:
            case DebatePhase.DEBATING:
                return renderDebate();
            case DebatePhase.VOTING:
                return renderVoting();
            case DebatePhase.FINISHED:
                return renderFinished();
            default:
                return null;
        }
    }

    return (
        <main className="bg-gray-100 min-h-screen w-full flex items-center justify-center p-4 font-sans">
             <div className={`w-full transition-all duration-500 ${
                phase === DebatePhase.DEBATING || phase === DebatePhase.ANALYZING 
                    ? 'max-w-3xl h-[80vh]' 
                    : 'max-w-4xl'
                }`}>
                {renderContent()}
            </div>
        </main>
    );
};

export default App;