import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, MapPin } from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";
import { useStore } from "@/store";
import React from "react";

export const LoginPage: React.FC = () => {
    const login = useStore((state) => state.login);
    const isLoggingIn = useStore((state) => state.auth.isLoggingIn);
    const loginError = useStore((state) => state.auth.loginError);

    const [username, setUsername] = React.useState("");
    const [password, setPassword] = React.useState("");

    const handleSubmit = async (e: React.SyntheticEvent) => {
        e.preventDefault();
        try {
            await login(username, password);
        } catch {
            // Error is handled in store and displayed via loginError
        }
    };

    return (
        <div className="fixed inset-0 flex items-center justify-center bg-background p-6 overflow-auto">
            <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-primary/5 pointer-events-none" />

            <div className="w-full max-w-[480px] z-10 m-auto">
                <div className="bg-muted/30 backdrop-blur-xl border border-border/50 rounded-2xl p-8 shadow-2xl">
                    <div className="flex flex-col items-center gap-4 mb-8">
                        <div className="w-16 h-16 rounded-xl bg-primary flex items-center justify-center shadow-lg shadow-primary/20">
                            <MapPin className="text-primary-foreground h-8 w-8" />
                        </div>
                        <div className="text-center">
                            <h1 className="text-3xl font-bold tracking-tight text-foreground">Flux360</h1>
                            <p className="text-base text-muted-foreground mt-1">Sign in to your account</p>
                        </div>
                    </div>

                    <div className="bg-card/40 backdrop-blur-xl border border-border/50 rounded-2xl p-8 shadow-2xl animate-in fade-in slide-in-from-bottom-8 duration-1000">
                        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-6">
                            <div className="space-y-4">
                                <div className="space-y-2">
                                    <Label htmlFor="username" className="text-xs font-semibold text-muted-foreground ml-1 uppercase tracking-wider">Username</Label>
                                    <div className="relative group">
                                        <div className="absolute -inset-0.5 bg-gradient-to-r from-primary/20 to-primary/10 rounded-lg blur opacity-0 group-focus-within:opacity-100 transition duration-500" />
                                        <Input
                                            id="username"
                                            type="text"
                                            value={username}
                                            onChange={(e) => setUsername(e.target.value)}
                                            required
                                            className="relative bg-background/50 border-border/50 focus:border-primary/50 transition-all duration-300 h-12 text-base rounded-lg"
                                        />
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <Label htmlFor="password" title="Password" className="text-xs font-semibold text-muted-foreground ml-1 uppercase tracking-wider">Password</Label>
                                    <div className="relative group">
                                        <div className="absolute -inset-0.5 bg-gradient-to-r from-primary/20 to-primary/10 rounded-lg blur opacity-0 group-focus-within:opacity-100 transition duration-500" />
                                        <Input
                                            id="password"
                                            type="password"
                                            value={password}
                                            onChange={(e) => setPassword(e.target.value)}
                                            required
                                            className="relative bg-background/50 border-border/50 focus:border-primary/50 transition-all duration-300 h-12 text-base rounded-lg"
                                        />
                                    </div>
                                </div>
                            </div>

                            {loginError && (
                                <div className="bg-destructive/10 border border-destructive/20 text-destructive text-sm p-4 rounded-lg animate-in shake-in duration-300 font-medium text-center">
                                    {loginError}
                                </div>
                            )}

                            <Button
                                type="submit"
                                className="w-full h-12 text-base font-bold tracking-tight uppercase transition-all duration-300 shadow-lg shadow-primary/20 hover:shadow-primary/30"
                                disabled={isLoggingIn}
                            >
                                {isLoggingIn ? (
                                    <div className="flex items-center gap-2">
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                        <span>Signing In...</span>
                                    </div>
                                ) : (
                                    "Sign In"
                                )}
                            </Button>
                        </form>
                    </div>
                </div>
            </div>

            <div className="fixed bottom-6 right-6 z-50">
                <ThemeToggle className="h-10 w-10 bg-background/50 backdrop-blur-md border-border/50 shadow-xl hover:bg-background/80 transition-all duration-300" />
            </div>
        </div>
    );
};
