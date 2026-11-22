"""Document knowledge bases (numen/kb_docs.py): reading files, passages, search."""

import io
import zipfile

import numpy as np
import pytest
from pydantic import ValidationError

from numen import kb_docs
from numen.models import KnowledgeBase


def test_documents_kb_needs_no_url_but_a_service_does():
    assert KnowledgeBase(name="Docs", type="documents").url == ""
    with pytest.raises(ValidationError):
        KnowledgeBase(name="Svc", type="rag_service", url="")
    with pytest.raises(ValidationError):
        KnowledgeBase(name="  ", type="documents")
    # Existing knowledge bases (no type stored) stay services.
    assert KnowledgeBase(name="Old", url="https://kb.example.org/").type == "rag_service"


def test_chunks_respect_size_and_overlap():
    paras = [f"Paragraph {i}. " + "word " * 40 for i in range(30)]
    chunks = kb_docs.chunk_text("\n\n".join(paras), size=600, overlap=250)
    assert len(chunks) > 1 and all(len(c) <= 600 for c in chunks)
    # Consecutive passages share a paragraph.
    assert chunks[0].split("\n\n")[-1] in chunks[1]
    # A huge paragraph is split on words; a giant word is cut.
    assert all(len(c) <= 100 for c in kb_docs.chunk_text("x" * 450 + " tail", size=100, overlap=0))


def _docx(paragraphs):
    w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    body = "".join(f"<w:p><w:r><w:t>{p}</w:t></w:r></w:p>" for p in paragraphs)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("word/document.xml", f'<w:document xmlns:w="{w}"><w:body>{body}</w:body></w:document>')
    return buf.getvalue()


def test_extracts_text_from_supported_files():
    assert kb_docs.extract_text("a.docx", _docx(["Office hours", "Mon to Fri, 8 to 5."])) == (
        "docx", "Office hours\n\nMon to Fri, 8 to 5.")
    kind, text = kb_docs.extract_text("p.html", b"<html><head><style>x{}</style></head><body><h1>Fees</h1>"
                                                b"<p>Tuition is &pound;10.</p><script>evil()</script></body></html>")
    assert kind == "html" and "Fees" in text and "Tuition is £10." in text and "evil" not in text
    assert kb_docs.extract_text("n.md", "﻿# Title\r\n\r\n\r\nBody  text".encode()) == ("md", "# Title\n\nBody text")
    assert kb_docs.extract_text("w.txt", "caf\xe9".encode("cp1252"))[1] == "café"


@pytest.mark.parametrize("name,data,msg", [
    ("x.exe", b"MZ", "Unsupported file type"),
    ("x.docx", b"not a zip", "Not a valid Word"),
    ("x.txt", b"   \n\n ", "No text found"),
    ("x.pdf", b"%PDF-broken", "Couldn't read"),
])
def test_bad_files_are_refused_with_a_reason(name, data, msg):
    with pytest.raises(kb_docs.DocumentError, match=msg):
        kb_docs.extract_text(name, data)


def test_too_large_file_is_refused():
    with pytest.raises(kb_docs.DocumentError, match="larger than"):
        kb_docs.extract_text("big.txt", b"a" * (kb_docs.MAX_FILE_BYTES + 1))


def test_search_returns_the_closest_passages():
    v = kb_docs._normalise(np.array([[1, 0, 0], [0, 1, 0], [0.9, 0.1, 0], [0, 0, 1]], dtype=np.float32))
    idx = kb_docs._Index(vectors=v, passages=["a", "b", "a2", "c"])
    q = kb_docs._normalise(np.array([[1, 0.05, 0]], dtype=np.float32))[0]
    assert kb_docs.search(idx, q, limit=2) == ["a", "a2"]
    assert kb_docs.search(kb_docs._Index(np.zeros((0, 1), np.float32), []), q) == []


def test_no_answer_marker():
    assert kb_docs.is_no_answer("NO_ANSWER") and kb_docs.is_no_answer(" no_answer. ")
    assert not kb_docs.is_no_answer("The fee is $10.")
