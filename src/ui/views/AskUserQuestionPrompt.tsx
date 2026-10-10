import React, { useState, useCallback, useRef } from "react";
import { Box, Text, useInput } from "ink";
import type { AskQuestionItem } from "../../tools/types.js";
import { useTheme } from "../contexts.js";
import { ansi256 } from "../theme.js";

interface Props {
  questions: AskQuestionItem[];
  resolve: (answers: Record<string, string> | null) => void;
  width: number;
}

export default function AskUserQuestionPrompt({ questions, resolve, width }: Props) {
  const theme = useTheme();
  const accentColor = theme.colorEnabled ? ansi256(theme.theme.accent) : undefined;
  const normalBorderColor = theme.colorEnabled ? ansi256(theme.theme.border) : undefined;
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [otherText, setOtherText] = useState("");
  const [showOther, setShowOther] = useState(false);
  const [focused, setFocused] = useState<"list" | "other">("list");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const otherTextRef = useRef("");

  const current = questions[currentIndex];
  if (!current) {
    resolve(answers);
    return null;
  }

  const hasOtherOption = true;
  const optionCount = current.options.length + (hasOtherOption ? 1 : 0);
  const isMulti = current.multiSelect;

  function confirmAnswer(answer: string) {
    const nextAnswers = { ...answers, [current.question]: answer };
    if (currentIndex + 1 >= questions.length) {
      resolve(nextAnswers);
    } else {
      setAnswers(nextAnswers);
      setCurrentIndex((i) => i + 1);
      setSelectedIndex(0);
      setSelectedIndices(new Set());
      setShowOther(false);
      setOtherText("");
      otherTextRef.current = "";
      setFocused("list");
    }
  }

  function cancel() {
    resolve(null);
  }

  useInput((value, key) => {
    if (focused === "other") {
      if (key.escape) {
        setFocused("list");
        setShowOther(false);
        setOtherText("");
        otherTextRef.current = "";
        return;
      }
      if (key.return) {
        const text = otherTextRef.current.trim();
        if (text) {
          confirmAnswer(text);
        }
        return;
      }
      if (key.backspace) {
        otherTextRef.current = otherTextRef.current.slice(0, -1);
        setOtherText(otherTextRef.current);
        return;
      }
      if (key.ctrl && (value === "c" || value === "C")) {
        return;
      }
      if (value && value.length === 1 && !key.ctrl && !key.meta && !key.shift) {
        otherTextRef.current += value;
        setOtherText(otherTextRef.current);
        return;
      }
      return;
    }

    if (key.escape) {
      cancel();
      return;
    }

    if (isMulti) {
      if (value === " " && !key.ctrl && !key.meta) {
        if (selectedIndex === current.options.length) {
          setShowOther((prev) => !prev);
          if (!showOther) {
            setFocused("list");
          }
          return;
        }
        setSelectedIndices((prev) => {
          const next = new Set(prev);
          if (next.has(selectedIndex)) {
            next.delete(selectedIndex);
          } else {
            next.add(selectedIndex);
          }
          return next;
        });
        return;
      }
      if (key.return) {
        if (selectedIndex === current.options.length) {
          setFocused("other");
          return;
        }
        const selected = Array.from(selectedIndices).map((i) => current.options[i].label);
        if (selected.length === 0) return;
        confirmAnswer(selected.join(", "));
        return;
      }
    } else {
      if (key.return) {
        if (selectedIndex === current.options.length) {
          setFocused("other");
          return;
        }
        confirmAnswer(current.options[selectedIndex].label);
        return;
      }
    }

    if (key.upArrow) {
      setSelectedIndex((i) => (i - 1 + optionCount) % optionCount);
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((i) => (i + 1) % optionCount);
      return;
    }

    const digitIndex = parseInt(value, 10);
    if (digitIndex >= 1 && digitIndex <= 9 && digitIndex <= optionCount) {
      setSelectedIndex(digitIndex - 1);
      if (!isMulti) {
        if (digitIndex - 1 === current.options.length) {
          setFocused("other");
          return;
        }
        confirmAnswer(current.options[digitIndex - 1].label);
      }
      return;
    }
  });

  // When the "Other" free-text field is focused, highlight the border with the
  // accent; otherwise use the normal border color.
  const borderColor = focused === "other" ? accentColor : normalBorderColor;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1} marginY={1} width={width}>
      <Box marginBottom={1}>
        <Text color={accentColor} bold>Question {currentIndex + 1}/{questions.length}</Text>
      </Box>
      <Text bold wrap="wrap">{current.question}</Text>
      <Box flexDirection="column" marginTop={1}>
        {current.options.map((opt, i) => {
          const isSelected = selectedIndex === i;
          if (isMulti) {
            const checked = selectedIndices.has(i);
            return (
              <Text key={i} color={isSelected ? accentColor : undefined}>
                {isSelected ? "> " : "  "}
                {checked ? "[x]" : "[ ]"} {opt.label}
                {opt.description ? <Text color={theme.colorEnabled ? ansi256(theme.theme.textDim) : undefined}> — {opt.description}</Text> : null}
              </Text>
            );
          }
          return (
            <Text key={i} color={isSelected ? accentColor : undefined}>
              {isSelected ? ">" : " "} {isSelected ? "\u25C9" : "\u25CB"} {opt.label}
              {opt.description ? <Text color={theme.colorEnabled ? ansi256(theme.theme.textDim) : undefined}> — {opt.description}</Text> : null}
            </Text>
          );
        })}
        <Text color={selectedIndex === current.options.length ? accentColor : (theme.colorEnabled ? ansi256(theme.theme.textDim) : undefined)}>
          {selectedIndex === current.options.length ? "> " : "  "}
          {isMulti && selectedIndex === current.options.length && showOther ? "[x]" : isMulti ? "[ ]" : selectedIndex === current.options.length ? "\u25C9" : "\u25CB"}
          {" "}Other
          {focused === "other" && selectedIndex === current.options.length && (
            <Text> — <Text color={accentColor} inverse> {otherText || (showOther ? "\u00A0" : "")} </Text></Text>
          )}
          {focused !== "other" && selectedIndex === current.options.length && showOther && (
            <Text> — {otherText || <Text color={theme.colorEnabled ? ansi256(theme.theme.textDim) : undefined}>type your answer</Text>}</Text>
          )}
          {focused !== "other" && (selectedIndex !== current.options.length || !showOther) && (
            <Text color={theme.colorEnabled ? ansi256(theme.theme.textDim) : undefined}> — type a custom answer</Text>
          )}
        </Text>
      </Box>
      <Box marginTop={1}>
        {isMulti ? (
          <Text color={theme.colorEnabled ? ansi256(theme.theme.textDim) : undefined}>↑↓ navigate · Space toggle · Enter confirm · Esc cancel</Text>
        ) : (
          <Text color={theme.colorEnabled ? ansi256(theme.theme.textDim) : undefined}>↑↓ navigate · 1-9 select · Enter choose · Esc cancel</Text>
        )}
      </Box>
    </Box>
  );
}
