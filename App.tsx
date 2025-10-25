import React, { useState, useRef, useEffect } from 'react';
import { AIPersona, DebatePhase, DebateMessage, Votes, Source, ArgumentComparison } from './types';
import { getDebateSides, generateDebateTurnStream, generateSpeech, generateDebateSummary, generateArgumentComparison } from './services/geminiService';
import { decode, decodeAudioData } from './utils/audioUtils';
import { LoadingSpinner, SendIcon, BrainIcon, SkipIcon, LinkIcon, FastForwardIcon } from './components/icons';

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
    const [comparison, setComparison] = useState<ArgumentComparison[] | null>(null);

    const audioContextRef = useRef<AudioContext | null>(null);
    const currentAudioSourceRef = useRef<AudioBufferSourceNode | null>(null);
    const debateLogRef = useRef<HTMLDivElement>(null);
    const isSkippedRef = useRef(false);
    const skipTrigger = useRef<((type: 'turn' | 'voting') => void) | null>(null);

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
        isSkippedRef.current = false;
        setPhase(DebatePhase.ANALYZING);
        setMessages([]);
        setSpeakingMessageIndex(null);
        setSummary(null);
        setComparison(null);

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
            const sources: Source[] = [];
            const sourceUris = new Set<string>();

            for await (const chunk of stream) {
                fullText += chunk.text;
                
                const groundingChunks = chunk.candidates?.[0]?.groundingMetadata?.groundingChunks;
                if (groundingChunks) {
                    for (const groundingChunk of groundingChunks) {
                        const source = groundingChunk.web;
                        if (source && source.uri && !sourceUris.has(source.uri)) {
                            sources.push({ uri: source.uri, title: source.title || source.uri });
                            sourceUris.add(source.uri);
                        }
                    }
                }

                setMessages(prev => {
                    const newMessages = [...prev];
                    newMessages[placeholderIndex] = { 
                        ...newMessages[placeholderIndex], 
                        text: fullText,
                        sources: sources.length > 0 ? sources : undefined
                    };
                    return newMessages;
                });
            }

            const finalMessage: DebateMessage = { persona, text: fullText, isStreaming: false, sources: sources.length > 0 ? sources : undefined };
            generatedMessages.push(finalMessage);
            currentHistory.push(finalMessage);

            setMessages(prev => {
                const newMessages = [...prev];
                newMessages[placeholderIndex] = finalMessage;
                return newMessages;
            });
        }
        
        // === PART 2: Generate Summary & Comparison ===
        setStatusText('Generating debate summary and analysis...');
        try {
            const [debateSummary, argumentComparison] = await Promise.all([
                generateDebateSummary(currentHistory),
                generateArgumentComparison(currentHistory)
            ]);
            setSummary(debateSummary);
            setComparison(argumentComparison);
        } catch(err: any) {
            console.error("Failed to generate post-debate analysis:", err.message);
        }

        // === PART 3: Generate and play audio ===
        setPhase(DebatePhase.DEBATING);
        setStatusText('Debate script generated. Starting playback...');
        
        initializeAudio();
        
        const firstMessageOffset = systemMessages.length;
        
        for (let i = 0; i < generatedMessages.length; i++) {
            if (isSkippedRef.current) break;

            const interruptPromise: Promise<'turn' | 'voting'> = new Promise(resolve => {
                skipTrigger.current = resolve;
            });

            const currentMessage = generatedMessages[i];
            const messageIndex = firstMessageOffset + i;
            setSpeakingMessageIndex(messageIndex);
            
            // Generate Audio
            setStatusText(`Generating audio for ${currentMessage.persona}...`);
            let audioData: string | undefined;
            try {
                const audioGenerationPromise = generateSpeech(currentMessage.text, currentMessage.persona as AIPersona);
                const result = await Promise.race([audioGenerationPromise, interruptPromise]);
                if (result === 'voting') break;
                if (result === 'turn') continue;
                audioData = result;
            } catch (err) {
                 if (!isSkippedRef.current) {
                     console.error("Error during audio generation:", err);
                     setError("Failed to generate audio for a turn.");
                 }
                break;
            }
            
            if (!audioData) continue;

            // Play Audio
            setStatusText(`Speaking: ${currentMessage.persona} (${debateTurns[i].stage})`);
            try {
                const playbackPromise = playAudio(audioData);
                const result = await Promise.race([playbackPromise, interruptPromise]);
                if (result === 'voting') break;
                if (result === 'turn') continue;
            } catch (err) {
                 if (!isSkippedRef.current) {
                    console.error("Error during audio playback:", err);
                    setError("Failed to play audio for a turn.");
                 }
                break;
            }
        }
        
        skipTrigger.current = null;
        if (!isSkippedRef.current) {
            setSpeakingMessageIndex(null);
            setStatusText('');
            setPhase(DebatePhase.VOTING);
        }
    }

    const playAudio = (base64Audio: string) => {
        return new Promise<void>(async (resolve, reject) => {
            if (!audioContextRef.current || isSkippedRef.current) return resolve();
            
            try {
                const decodedData = decode(base64Audio);
                const audioBuffer = await decodeAudioData(decodedData, audioContextRef.current, 24000, 1);
                
                if (isSkippedRef.current) return resolve();
    
                const source = audioContextRef.current!.createBufferSource();
                currentAudioSourceRef.current = source;
                source.buffer = audioBuffer;
                source.connect(audioContextRef.current!.destination);
                source.onended = () => {
                    if (currentAudioSourceRef.current === source) {
                        currentAudioSourceRef.current = null;
                    }
                    resolve();
                };
                source.start();
            } catch (err) {
                reject(err);
            }
        });
    };

    const handleSkip = () => {
        if (currentAudioSourceRef.current) {
            currentAudioSourceRef.current.stop();
        }
        skipTrigger.current?.('turn');
    };

    const handleSkipToVoting = () => {
        if (isSkippedRef.current) return;
        isSkippedRef.current = true;
        if (currentAudioSourceRef.current) {
            currentAudioSourceRef.current.stop();
        }
        skipTrigger.current?.('voting');
        setSpeakingMessageIndex(null);
        setStatusText('');
        setPhase(DebatePhase.VOTING);
    };

    const handleVote = (persona: AIPersona) => {
        setVotes(prev => ({ ...prev, [persona]: prev[persona] + 1 }));
        setPhase(DebatePhase.FINISHED);
    };

    const handleReset = () => {
        isSkippedRef.current = false;
        if (currentAudioSourceRef.current) {
            currentAudioSourceRef.current.stop();
            currentAudioSourceRef.current = null;
        }
        setPhase(DebatePhase.IDLE);
        setQuestion('');
        setMessages([]);
        setError(null);
        setVotes({ [AIPersona.Logos]: 0, [AIPersona.Pathos]: 0 });
        setSpeakingMessageIndex(null);
        setStatusText('');
        setSummary(null);
        setComparison(null);
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
            <div className="p-4 border-b flex justify-between items-center">
                <div>
                    <h2 className="text-lg font-semibold text-gray-800 truncate">Debate: {question}</h2>
                    {statusText && (
                        <p className="text-sm text-gray-500 h-5 flex items-center">
                            {phase === DebatePhase.ANALYZING && <LoadingSpinner className="w-4 h-4 mr-2" />}
                            {statusText}
                            {(phase === DebatePhase.ANALYZING || phase === DebatePhase.DEBATING) && <span className="animate-pulse">...</span>}
                        </p>
                    )}
                </div>
                {phase === DebatePhase.DEBATING && (
                    <button 
                        onClick={handleSkipToVoting}
                        className="flex items-center gap-2 bg-gray-200 text-gray-700 font-semibold py-2 px-3 rounded-lg hover:bg-gray-300 transition-colors text-sm"
                        aria-label="Skip to voting"
                    >
                        <FastForwardIcon className="w-4 h-4" />
                        Skip to Voting
                    </button>
                )}
            </div>
            <div ref={debateLogRef} className="flex-grow p-4 space-y-4 overflow-y-auto">
                {messages.map((msg, index) => (
                    <div 
                        key={index} 
                        className={`flex items-start gap-3 max-w-xl transition-all duration-300 ${msg.persona === AIPersona.Logos ? 'ml-auto flex-row-reverse' : msg.persona === AIPersona.Pathos ? 'mr-auto' : 'mx-auto'} ${speakingMessageIndex === index ? 'scale-105' : ''}`}
                    >
                        {msg.persona !== 'SYSTEM' && (
                            <div className={`w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center font-bold text-white mt-1 ${msg.persona === AIPersona.Logos ? 'bg-blue-600' : 'bg-purple-600'}`}>
                                {msg.persona.slice(0, 1)}
                            </div>
                        )}
                        <div className={`p-3 rounded-lg relative flex-1 ${
                            msg.persona === AIPersona.Logos ? 'bg-blue-100 text-blue-900' :
                            msg.persona === AIPersona.Pathos ? 'bg-purple-100 text-purple-900' :
                            'bg-gray-200 text-gray-700 text-center w-full'
                        } ${speakingMessageIndex === index ? 'ring-2 ring-yellow-400' : ''}`}>
                            <p className="text-sm">{msg.text}{msg.isStreaming && <span className="inline-block w-1 h-4 bg-gray-600 animate-pulse ml-1"></span>}</p>
                            {msg.sources && msg.sources.length > 0 && !msg.isStreaming && (
                                <div className="mt-2 pt-2 border-t border-blue-200/50">
                                    <h4 className="text-xs font-bold text-blue-800/70 mb-1 flex items-center gap-1.5">
                                        <LinkIcon className="w-3.5 h-3.5" />
                                        Sources
                                    </h4>
                                    <ul className="text-xs space-y-1">
                                        {msg.sources.slice(0, 3).map((source, i) => (
                                            <li key={i} className="truncate">
                                                <a 
                                                    href={source.uri} 
                                                    target="_blank" 
                                                    rel="noopener noreferrer"
                                                    className="text-blue-600 hover:underline"
                                                    title={source.uri}
                                                >
                                                    {source.title}
                                                </a>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>
                        {speakingMessageIndex === index && phase === DebatePhase.DEBATING && (
                            <button 
                                onClick={handleSkip}
                                className="p-2 rounded-full bg-gray-200 hover:bg-gray-300 text-gray-600 transition-colors flex-shrink-0 mt-1"
                                aria-label="Skip to next turn"
                            >
                                <SkipIcon className="w-5 h-5" />
                            </button>
                        )}
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
            
            {comparison ? (
                <div className="mb-10">
                    <h3 className="text-2xl font-bold mb-4 text-gray-800">Argument Breakdown</h3>
                    <div className="overflow-x-auto bg-gray-50 rounded-lg border">
                        <table className="w-full text-sm text-left text-gray-700">
                            <thead className="bg-gray-100 text-xs text-gray-800 uppercase">
                                <tr>
                                    <th scope="col" className="px-6 py-3">Point of Contention</th>
                                    <th scope="col" className="px-6 py-3">Logos (Logic & Data)</th>
                                    <th scope="col" className="px-6 py-3">Pathos (Emotion & Morality)</th>
                                </tr>
                            </thead>
                            <tbody>
                                {comparison.map((row, index) => (
                                    <tr key={index} className="bg-white border-b hover:bg-gray-50">
                                        <td className="px-6 py-4 font-semibold text-gray-900">{row.topic}</td>
                                        <td className="px-6 py-4">{row.logosStance}</td>
                                        <td className="px-6 py-4">{row.pathosStance}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            ) : (
                <div className="mb-10">
                    <h3 className="text-2xl font-bold mb-4 text-gray-800">Argument Breakdown</h3>
                    <div className="flex justify-center items-center h-32 bg-gray-50 rounded-lg border">
                        <LoadingSpinner />
                        <p className="ml-4 text-gray-500">Analyzing arguments...</p>
                    </div>
                </div>
            )}

            <div className="flex justify-center gap-8">
                <button 
                    onClick={() => handleVote(AIPersona.Logos)} 
                    className="bg-blue-600 text-white font-bold py-4 px-8 rounded-lg hover:bg-blue-700 transition-transform hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed"
                    disabled={!summary || !comparison}
                >
                    Vote for Logos
                </button>
                <button 
                    onClick={() => handleVote(AIPersona.Pathos)} 
                    className="bg-purple-600 text-white font-bold py-4 px-8 rounded-lg hover:bg-purple-700 transition-transform hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed"
                    disabled={!summary || !comparison}
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
