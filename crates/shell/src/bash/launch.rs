//! The program a command line runs after its launchers and their options.
//!
//! The host URL resolver and trace highlighting both need the same answer:
//! an option's value is not the program, and a wrapper's own file arguments
//! belong to the wrapper rather than to the program it eventually runs.

/// A command line past its launchers (`env`, `timeout`, `sudo`, `uv run`,
/// `ssh host`, …).
pub(crate) struct Launch {
	/// Index of the word naming the program; for `ssh`, of its first remote
	/// word, if any (none: the remote login shell runs stdin).
	pub(crate) at:     usize,
	/// The program runs on an `ssh` host.
	pub(crate) remote: bool,
}

fn text(word: &impl AsRef<[u8]>) -> &str {
	std::str::from_utf8(word.as_ref()).unwrap_or("")
}

fn basename(word: &str) -> &str {
	word.rsplit('/').next().unwrap_or(word)
}

/// `NAME=VALUE`, as the shell and `sudo` take before the command they run.
pub(crate) fn assignment(word: &str) -> bool {
	word.split_once('=').is_some_and(|(name, _)| {
		name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
			&& name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
	})
}

/// `env` accepts names a shell assignment would reject (`tool.name=value`).
fn env_assignment(word: &str) -> bool {
	word
		.split_once('=')
		.is_some_and(|(name, _)| !name.is_empty())
}

/// Index of the first operand from `from` on, past the options; `takes_value`
/// names the options whose value is the next word.
fn operand<T: AsRef<[u8]>>(words: &[T], from: usize, takes_value: impl Fn(&str) -> bool) -> usize {
	let mut i = from;
	while let Some(word) = words.get(i) {
		let word = text(word);
		if word == "--" {
			return i + 1;
		}
		if !word.starts_with('-') || word == "-" {
			break;
		}
		i += if takes_value(word) { 2 } else { 1 };
	}
	i
}

fn npm_global_value(word: &str) -> bool {
	matches!(
		word,
		"--prefix"
			| "--cache"
			| "--registry"
			| "--loglevel"
			| "--userconfig"
			| "--globalconfig"
			| "--workspace"
			| "-w"
			| "--node-options"
			| "--location"
			| "--otp"
	)
}

fn npx_value(word: &str) -> bool {
	npm_global_value(word) || matches!(word, "-p" | "--package" | "-c" | "--call" | "--npm")
}

fn npm_exec_value(word: &str) -> bool {
	// Unlike npx, npm's `-p` means parseable output, not a package.
	npm_global_value(word) || matches!(word, "--package" | "-c" | "--call")
}

fn bunx_value(word: &str) -> bool {
	matches!(
		word,
		"--registry"
			| "--cache-dir"
			| "--minimum-release-age"
			| "--backend"
			| "--linker"
			| "--filter"
			| "--config"
			| "--cwd"
	)
}

fn xargs_value(word: &str) -> bool {
	matches!(
		word,
		"-a"
			| "--arg-file"
			| "-d"
			| "--delimiter"
			| "-E"
			| "--eof"
			| "-I"
			| "--replace"
			| "-L"
			| "--max-lines"
			| "-n"
			| "--max-args"
			| "-P"
			| "--max-procs"
			| "-s"
			| "--max-chars"
			| "--process-slot-var"
	)
}

/// Words a launcher at the start of `words` takes before the command it runs
/// (`timeout 5 cmd` → 2), and whether that command runs on an `ssh` host.
fn launcher<T: AsRef<[u8]>>(words: &[T]) -> Option<(usize, bool)> {
	let skip = match basename(text(words.first()?)) {
		"env" => {
			// Options precede env's optional compatibility dash and settings;
			// after `--`, a setting may itself begin with a dash.
			let at = operand(words, 1, |w| {
				matches!(w, "-u" | "--unset" | "-C" | "--chdir" | "-S" | "--split-string" | "-P")
			});
			let at = at + usize::from(words.get(at).is_some_and(|w| text(w) == "-"));
			at + words
				.iter()
				.skip(at)
				.take_while(|w| env_assignment(text(*w)))
				.count()
		},
		"sudo" | "doas" => {
			let at = operand(words, 1, |w| {
				matches!(
					w,
					"-u"
						| "-g"
						| "-C"
						| "-D"
						| "-h"
						| "-p"
						| "-R"
						| "-r"
						| "-T"
						| "-t"
						| "-U"
						| "--user"
						| "--group"
						| "--close-from"
						| "--chdir"
						| "--host"
						| "--prompt"
						| "--chroot"
						| "--role"
						| "--command-timeout"
						| "--type"
						| "--other-user"
				)
			});
			at + words
				.iter()
				.skip(at)
				.take_while(|w| assignment(text(*w)))
				.count()
		},
		// The first operand is the duration.
		"timeout" | "gtimeout" => {
			operand(words, 1, |w| matches!(w, "-s" | "--signal" | "-k" | "--kill-after")) + 1
		},
		"nice" => operand(words, 1, |w| matches!(w, "-n" | "--adjustment")),
		"nohup" | "setsid" | "ifne" => operand(words, 1, |_| false),
		"time" => operand(words, 1, |w| matches!(w, "-o" | "--output" | "-f" | "--format")),
		"stdbuf" => {
			operand(words, 1, |w| matches!(w, "-i" | "-o" | "-e" | "--input" | "--output" | "--error"))
		},
		"exec" => operand(words, 1, |w| w == "-a"),
		"xargs" => operand(words, 1, xargs_value),
		"npx" => operand(words, 1, npx_value),
		"bunx" => operand(words, 1, bunx_value),
		"npm" => {
			let mut at = 1;
			loop {
				match words.get(at).map(text) {
					Some("exec") => break operand(words, at + 1, npm_exec_value),
					Some("--") | None => return None,
					Some(word) if word.starts_with('-') && word != "-" => {
						at += if npm_global_value(word) { 2 } else { 1 };
					},
					Some(_) => return None,
				}
			}
		},
		"uv" if words.get(1).is_some_and(|w| text(w) == "run") => operand(words, 2, |w| {
			matches!(
				w,
				"--with"
					| "-w"
					| "--with-editable"
					| "--with-requirements"
					| "-p"
					| "--python"
					| "--package"
					| "--project"
					| "--directory"
					| "--env-file"
					| "--extra"
					| "--group"
					| "--only-group"
					| "--no-group"
					| "--index"
					| "--default-index"
					| "-i"
					| "--index-url"
					| "--extra-index-url"
					| "-f"
					| "--find-links"
					| "--config-file"
					| "--cache-dir"
			)
		}),
		"ssh" => {
			let host = operand(words, 1, |w| w.len() == 2 && "pilojFSLRDWbcEemOQw".contains(&w[1..]));
			return (host < words.len()).then_some((host + 1, true));
		},
		_ => return None,
	};
	Some((skip, false))
}

pub(crate) fn launch<T: AsRef<[u8]>>(words: &[T]) -> Launch {
	let at = words.iter().take_while(|w| assignment(text(*w))).count();
	let mut launch = Launch { at, remote: false };
	while let Some((skip, remote)) = launcher(&words[launch.at..]) {
		launch.at = (launch.at + skip).min(words.len());
		launch.remote |= remote;
	}
	launch
}

#[cfg(test)]
mod tests {
	use super::*;

	fn at(words: &[&str]) -> Option<usize> {
		let words = words
			.iter()
			.map(|word| (*word).to_owned())
			.collect::<Vec<_>>();
		let launch = launch(&words);
		(!launch.remote).then_some(launch.at)
	}

	#[test]
	fn finds_only_the_program_behind_launcher_options() {
		assert_eq!(at(&["grep", "omp", "local://out.txt"]), Some(0));
		assert_eq!(at(&["npx", "--cache", "omp", "eslint", "local://app.ts"]), Some(3));
		assert_eq!(at(&["npx", "--loglevel", "warn", "omp", "read"]), Some(3));
		assert_eq!(at(&["npm", "--prefix", "tools", "exec", "--", "omp", "read"]), Some(5));
		assert_eq!(at(&["npm", "exec", "-p", "omp", "read"]), Some(3));
		assert_eq!(at(&["bunx", "--minimum-release-age", "86400", "omp", "read"]), Some(3));
		assert_eq!(at(&["uv", "run", "-w", "requests", "omp", "read"]), Some(4));
		assert_eq!(at(&["env", "--", "-flag=/opt/omp", "grep", "local://file"]), Some(3));
		assert_eq!(at(&["env", "-", "tool.name=/opt/omp", "omp", "read"]), Some(3));
		assert_eq!(at(&["setsid", "omp", "read"]), Some(1));
		assert_eq!(at(&["xargs", "-n", "2", "omp", "read"]), Some(3));
		assert_eq!(at(&["ifne", "-n", "omp", "read"]), Some(2));
	}
}
